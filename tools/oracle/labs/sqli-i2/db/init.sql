CREATE TABLE customers (name TEXT, email TEXT);
INSERT INTO customers VALUES ('alice','alice@corp.local'),('bob','bob@corp.local'),('carol','carol@corp.local');
CREATE TABLE vault (k TEXT, v TEXT);
INSERT INTO vault VALUES ('flag','OZZULAB{sqli_i2_pg_union_2026}');
