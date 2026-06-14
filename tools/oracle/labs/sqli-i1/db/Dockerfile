FROM mysql:8.0
ENV MYSQL_ROOT_PASSWORD=rootpw
COPY init.sql /docker-entrypoint-initdb.d/10-init.sql
