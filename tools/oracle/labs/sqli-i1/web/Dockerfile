FROM php:8.2-apache
RUN docker-php-ext-install mysqli >/dev/null 2>&1
COPY index.php /var/www/html/index.php
