CREATE DATABASE IF NOT EXISTS appdb;
USE appdb;
CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(100), descr TEXT);
INSERT INTO products VALUES (1,'Widget','basic widget'),(2,'Gadget','useful gadget');
CREATE TABLE secrets (id INT PRIMARY KEY, k VARCHAR(50), v VARCHAR(200));
INSERT INTO secrets VALUES (1,'flag','OZZULAB{sqli_i1_union_readout_2026}');
CREATE USER IF NOT EXISTS 'webuser'@'%' IDENTIFIED BY 'webpass';
GRANT SELECT ON appdb.* TO 'webuser'@'%';
