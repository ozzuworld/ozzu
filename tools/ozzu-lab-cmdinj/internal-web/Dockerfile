FROM debian:bullseye

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      apache2 php php-mysql libapache2-mod-php \
      openssh-server mariadb-client \
      net-tools iputils-ping curl ca-certificates \
      dnsutils traceroute && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd

# Operator persona — slightly different from variant #1's webdev
RUN useradd -m -s /bin/bash netops && \
    echo 'netops:prodops_2026' | chpasswd && \
    echo 'root:RootNetops_2026' | chpasswd

# Vulnerable PHP app — command injection in diagnose.php (intentional)
COPY app/ /var/www/html/

# Flag — readable by www-data after RCE
COPY flag2.txt /var/lib/ops-tools/.flag
RUN chmod 644 /var/lib/ops-tools/.flag

# Apache enable PHP
RUN a2enmod php7.4 2>/dev/null || a2enmod php7.3 2>/dev/null || a2enmod php
RUN chown -R www-data:www-data /var/www/html

EXPOSE 22 80

CMD ["/bin/bash", "-c", "service ssh start && apache2ctl -D FOREGROUND"]
