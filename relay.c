#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <getopt.h>
#include <errno.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <signal.h>
#include <time.h>
#include <pthread.h>

#define BUFFER_SIZE 4096
#define MAX_CLIENTS 200

/* Global counter and mutex for TCP active connections */
pthread_mutex_t connection_count_mutex = PTHREAD_MUTEX_INITIALIZER;
int active_connections = 0;

/* Structure to pass connection parameters to a thread (TCP only) */
struct tcp_connection_args {
    int client_sock;
    char client_ip[INET_ADDRSTRLEN];
    const char *remote_ip;
    int remote_port;
};

/* Thread function to handle a single TCP connection */
void *tcp_connection_handler(void *arg) {
    struct tcp_connection_args *args = (struct tcp_connection_args *)arg;
    int client_sock = args->client_sock;
    const char *remote_ip = args->remote_ip;
    int remote_port = args->remote_port;
    char client_ip[INET_ADDRSTRLEN];
    strncpy(client_ip, args->client_ip, INET_ADDRSTRLEN);
    free(args);

    int remote_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (remote_sock < 0) {
        perror("TCP remote socket");
        close(client_sock);
        pthread_exit(NULL);
    }
    struct sockaddr_in remote_addr;
    memset(&remote_addr, 0, sizeof(remote_addr));
    remote_addr.sin_family = AF_INET;
    remote_addr.sin_port = htons(remote_port);
    inet_pton(AF_INET, remote_ip, &remote_addr.sin_addr);
    if (connect(remote_sock, (struct sockaddr *)&remote_addr, sizeof(remote_addr)) < 0) {
        perror("TCP connect");
        close(client_sock);
        close(remote_sock);
        pthread_exit(NULL);
    }

    /* Print connection message with current active TCP connection count */
    pthread_mutex_lock(&connection_count_mutex);
    int current_connections = active_connections;
    pthread_mutex_unlock(&connection_count_mutex);
    printf("TCP connection from %s connected. Active connections: %d\n", client_ip, current_connections);

    fd_set readfds;
    int maxfd = (client_sock > remote_sock ? client_sock : remote_sock) + 1;
    char buffer[BUFFER_SIZE];
    while (1) {
        FD_ZERO(&readfds);
        FD_SET(client_sock, &readfds);
        FD_SET(remote_sock, &readfds);
        if (select(maxfd, &readfds, NULL, NULL, NULL) <= 0)
            break;
        if (FD_ISSET(client_sock, &readfds)) {
            int n = read(client_sock, buffer, BUFFER_SIZE);
            if (n <= 0)
                break;
            if (write(remote_sock, buffer, n) <= 0)
                break;
        }
        if (FD_ISSET(remote_sock, &readfds)) {
            int n = read(remote_sock, buffer, BUFFER_SIZE);
            if (n <= 0)
                break;
            if (write(client_sock, buffer, n) <= 0)
                break;
        }
    }
    close(client_sock);
    close(remote_sock);

    /* Decrement and print disconnection message with updated active connection count */
    pthread_mutex_lock(&connection_count_mutex);
    active_connections--;
    current_connections = active_connections;
    pthread_mutex_unlock(&connection_count_mutex);
    printf("TCP connection from %s disconnected. Active connections: %d\n", client_ip, current_connections);

    pthread_exit(NULL);
}

/* TCP Relay: Uses threads for each connection */
void tcp_relay(int local_port, const char *remote_ip, int remote_port) {
    int listen_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_sock < 0) {
        perror("TCP socket");
        exit(1);
    }
    int opt = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in local_addr;
    memset(&local_addr, 0, sizeof(local_addr));
    local_addr.sin_family = AF_INET;
    local_addr.sin_addr.s_addr = INADDR_ANY;
    local_addr.sin_port = htons(local_port);

    if (bind(listen_sock, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0) {
        perror("TCP bind");
        exit(1);
    }
    if (listen(listen_sock, 5) < 0) {
        perror("TCP listen");
        exit(1);
    }

    printf("TCP relay on port %d, forwarding to %s:%d\n", local_port, remote_ip, remote_port);

    while (1) {
        struct sockaddr_in client_addr;
        socklen_t addrlen = sizeof(client_addr);
        int client_sock = accept(listen_sock, (struct sockaddr *)&client_addr, &addrlen);
        if (client_sock < 0) {
            perror("TCP accept");
            continue;
        }
        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);

        /* Increment active connection count */
        pthread_mutex_lock(&connection_count_mutex);
        active_connections++;
        pthread_mutex_unlock(&connection_count_mutex);

        /* Allocate and set up parameters for the new thread */
        struct tcp_connection_args *args = malloc(sizeof(struct tcp_connection_args));
        if (!args) {
            perror("malloc");
            close(client_sock);
            continue;
        }
        args->client_sock = client_sock;
        strncpy(args->client_ip, client_ip, INET_ADDRSTRLEN);
        args->remote_ip = remote_ip;  // Ensure remote_ip remains valid
        args->remote_port = remote_port;

        pthread_t tid;
        if (pthread_create(&tid, NULL, tcp_connection_handler, args) != 0) {
            perror("pthread_create");
            close(client_sock);
            free(args);
            /* Decrement count if thread creation fails */
            pthread_mutex_lock(&connection_count_mutex);
            active_connections--;
            pthread_mutex_unlock(&connection_count_mutex);
            continue;
        }
        /* Detach the thread so its resources are freed when it terminates */
        pthread_detach(tid);
    }
}

/* UDP Relay: Single process, manages multiple clients */
void udp_relay(int local_port, const char *remote_ip, int remote_port, int timeout_sec) {
    int listen_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (listen_sock < 0) {
        perror("UDP socket");
        exit(1);
    }
    int opt = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in local_addr;
    memset(&local_addr, 0, sizeof(local_addr));
    local_addr.sin_family = AF_INET;
    local_addr.sin_addr.s_addr = INADDR_ANY;
    local_addr.sin_port = htons(local_port);

    if (bind(listen_sock, (struct sockaddr *)&local_addr, sizeof(local_addr)) < 0) {
        perror("UDP bind");
        exit(1);
    }

    printf("UDP relay on port %d, forwarding to %s:%d\n", local_port, remote_ip, remote_port);

    struct client_entry {
        struct sockaddr_in client_addr;
        int remote_sock;
        time_t last_activity;
    } clients[MAX_CLIENTS];
    int num_clients = 0;

    while (1) {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(listen_sock, &readfds);
        int maxfd = listen_sock;
        for (int i = 0; i < num_clients; i++) {
            FD_SET(clients[i].remote_sock, &readfds);
            if (clients[i].remote_sock > maxfd)
                maxfd = clients[i].remote_sock;
        }

        struct timeval tv = {timeout_sec, 0};
        int ret = select(maxfd + 1, &readfds, NULL, NULL, &tv);
        if (ret < 0) {
            perror("UDP select");
            break;
        }

        /* Handle incoming client datagrams */
        if (FD_ISSET(listen_sock, &readfds)) {
            char buffer[BUFFER_SIZE];
            struct sockaddr_in client_addr;
            socklen_t addrlen = sizeof(client_addr);
            int n = recvfrom(listen_sock, buffer, BUFFER_SIZE, 0,
                             (struct sockaddr *)&client_addr, &addrlen);
            if (n > 0) {
                char client_ip[INET_ADDRSTRLEN];
                inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);

                int client_index = -1;
                for (int i = 0; i < num_clients; i++) {
                    if (memcmp(&clients[i].client_addr, &client_addr, sizeof(client_addr)) == 0) {
                        client_index = i;
                        break;
                    }
                }
                if (client_index == -1 && num_clients < MAX_CLIENTS) {
                    int remote_sock = socket(AF_INET, SOCK_DGRAM, 0);
                    if (remote_sock < 0)
                        continue;
                    struct sockaddr_in remote_addr;
                    memset(&remote_addr, 0, sizeof(remote_addr));
                    remote_addr.sin_family = AF_INET;
                    remote_addr.sin_port = htons(remote_port);
                    inet_pton(AF_INET, remote_ip, &remote_addr.sin_addr);
                    if (connect(remote_sock, (struct sockaddr *)&remote_addr, sizeof(remote_addr)) < 0) {
                        close(remote_sock);
                        continue;
                    }
                    clients[num_clients].client_addr = client_addr;
                    clients[num_clients].remote_sock = remote_sock;
                    clients[num_clients].last_activity = time(NULL);
                    num_clients++;
                    printf("UDP connection from %s connected. Active connections: %d\n", client_ip, num_clients);
                    client_index = num_clients - 1;
                }
                if (client_index != -1) {
                    if (send(clients[client_index].remote_sock, buffer, n, 0) > 0) {
                        clients[client_index].last_activity = time(NULL);
                    }
                }
            }
        }

        /* Handle responses from remote server */
        for (int i = 0; i < num_clients; i++) {
            if (FD_ISSET(clients[i].remote_sock, &readfds)) {
                char buffer[BUFFER_SIZE];
                int n = recv(clients[i].remote_sock, buffer, BUFFER_SIZE, 0);
                if (n > 0) {
                    sendto(listen_sock, buffer, n, 0,
                           (struct sockaddr *)&clients[i].client_addr, sizeof(clients[i].client_addr));
                    clients[i].last_activity = time(NULL);
                }
            }
        }

        /* Clean up inactive clients and print disconnection messages */
        time_t now = time(NULL);
        for (int i = num_clients - 1; i >= 0; i--) {
            if (now - clients[i].last_activity > timeout_sec) {
                char client_ip[INET_ADDRSTRLEN];
                inet_ntop(AF_INET, &clients[i].client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);
                close(clients[i].remote_sock);
                // Shift remaining clients down in the array
                for (int j = i; j < num_clients - 1; j++) {
                    clients[j] = clients[j + 1];
                }
                num_clients--;
                printf("UDP connection from %s disconnected. Active connections: %d\n", client_ip, num_clients);
            }
        }
    }
    close(listen_sock);
}

/* Main Program */
void usage(const char *progname) {
    fprintf(stderr, "Usage: %s [-p tcp|udp] -l local_port -r remote_ip:remote_port [-T timeout_sec]\n", progname);
    exit(1);
}

int main(int argc, char *argv[]) {
    int opt;
    char *protocol = NULL;
    int local_port = 0;
    char *remote_ip = NULL;
    int remote_port = 0;
    int timeout_sec = 15;

    while ((opt = getopt(argc, argv, "p:l:r:T:")) != -1) {
        switch (opt) {
            case 'p': protocol = optarg; break;
            case 'l': local_port = atoi(optarg); break;
            case 'r':
                if (optind < argc) {
                    remote_ip = optarg;
                    remote_port = atoi(argv[optind]);
                    optind++;
                } else usage(argv[0]);
                break;
            case 'T': timeout_sec = atoi(optarg); break;
            default: usage(argv[0]);
        }
    }

    if (local_port <= 0 || !remote_ip || remote_port <= 0)
        usage(argv[0]);

    signal(SIGCHLD, SIG_IGN);  // No longer needed for TCP threads, but kept for UDP if any child processes exist

    if (protocol) {
        if (strcmp(protocol, "tcp") == 0) {
            tcp_relay(local_port, remote_ip, remote_port);
        } else if (strcmp(protocol, "udp") == 0) {
            udp_relay(local_port, remote_ip, remote_port, timeout_sec);
        } else {
            usage(argv[0]);
        }
    } else {
        /* No -p: Run both TCP and UDP */
        pid_t pid = fork();
        if (pid < 0) {
            perror("fork");
            exit(1);
        } else if (pid == 0) {
            /* Child: TCP relay (using threads) */
            tcp_relay(local_port, remote_ip, remote_port);
            exit(0);
        }
        /* Parent: UDP relay */
        udp_relay(local_port, remote_ip, remote_port, timeout_sec);
    }
    return 0;
}
