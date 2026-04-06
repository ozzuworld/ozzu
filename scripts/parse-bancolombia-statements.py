#!/usr/bin/env python3
"""Parse Bancolombia PDF bank statements and insert into transactions table."""

import imaplib
import email
import fitz  # pymupdf
import re
import psycopg2
import tempfile
import os
from datetime import datetime, date

IMAP_USER = "eng.hsuarezp@gmail.com"
IMAP_PASS = "fxes yzhe jsdk ateh"
CEDULA = "1140843957"
DB_DSN = "host=127.0.0.1 port=5432 dbname=ozzu user=ozzu password=ozzu"

def parse_amount(s):
    """Parse COP amount string like -7,095.00 or 600,000.00"""
    s = s.strip().replace(",", "")
    try:
        return float(s)
    except:
        return None

def parse_statement_pdf(pdf_bytes, statement_year_hint=None):
    """Extract transactions from a Bancolombia statement PDF."""
    txns = []
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = f.name

    try:
        doc = fitz.open(tmp_path)
        if doc.needs_pass:
            if not doc.authenticate(CEDULA):
                print(f"  ❌ Wrong password for PDF")
                return []

        # Extract period from page 1 text
        full_text = ""
        for page in doc:
            full_text += page.get_text() + "\n"

        # Detect period: "DESDE: 2021/10/01" or "PERIODO: Oct 2021"
        year = statement_year_hint or datetime.now().year
        m = re.search(r'DESDE:\s*(\d{4})/(\d{2})/\d{2}', full_text)
        if m:
            year = int(m.group(1))
            start_month = int(m.group(2))
        else:
            m = re.search(r'(\d{4})/(\d{2})/\d{2}', full_text)
            if m:
                year = int(m.group(1))
                start_month = int(m.group(2))
            else:
                start_month = None

        # Parse transaction lines
        # Format: DD/MM\nDESCRIPCIÓN\nSUCURSAL (optional)\nDCTO (optional)\nVALOR\nSALDO
        # Simpler approach: split by lines and look for date + amount patterns
        lines = [l.strip() for l in full_text.split("\n") if l.strip()]

        i = 0
        while i < len(lines):
            line = lines[i]
            # Match date pattern DD/MM (possibly DD/MM/YYYY)
            date_m = re.match(r'^(\d{1,2})/(\d{2})(?:/(\d{4}))?$', line)
            if date_m:
                day = int(date_m.group(1))
                month = int(date_m.group(2))
                txn_year = int(date_m.group(3)) if date_m.group(3) else year
                
                # Determine year: if month < start_month, it's next year (e.g. statement Dec→Jan)
                # Collect description and amounts from next lines
                desc_parts = []
                valor = None
                saldo = None
                
                j = i + 1
                while j < len(lines) and j < i + 6:
                    next_line = lines[j]
                    # Amount pattern: -1,234.56 or 1,234.56
                    amt_m = re.match(r'^-?[\d,]+\.\d{2}$', next_line)
                    if amt_m:
                        amt = parse_amount(next_line)
                        if valor is None:
                            valor = amt
                        else:
                            saldo = amt
                            break
                    elif re.match(r'^(\d{1,2})/(\d{2})$', next_line):
                        break  # next transaction
                    elif next_line not in ("FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO", "FIN ESTADO DE CUENTA"):
                        desc_parts.append(next_line)
                    j += 1
                
                if valor is not None and desc_parts:
                    description = " ".join(desc_parts[:2])  # max 2 desc lines
                    try:
                        txn_date = date(txn_year, month, day)
                    except ValueError:
                        txn_date = date(txn_year, month, min(day, 28))
                    
                    # Classify type
                    desc_upper = description.upper()
                    if "NÓMINA" in desc_upper or "NOMINA" in desc_upper or "ABONO NOMINA" in desc_upper:
                        txn_type = "salary"
                    elif "TRANSFERENCIA DESDE" in desc_upper or "RECEPCION" in desc_upper or "ABONO" in desc_upper:
                        txn_type = "transfer_in"
                    elif "TRANSFERENCIA A " in desc_upper or "TRANSFERENCIA CTA SUC" in desc_upper:
                        txn_type = "transfer_out"
                    elif "COMPRA" in desc_upper:
                        txn_type = "purchase"
                    elif "RETIRO" in desc_upper or "CAJERO" in desc_upper:
                        txn_type = "withdrawal"
                    elif "IMPTO" in desc_upper or "4X1000" in desc_upper:
                        txn_type = "tax"
                    elif "CUOTA MANEJO" in desc_upper or "CARGO" in desc_upper:
                        txn_type = "fee"
                    elif "INTERÉS" in desc_upper or "INTERES" in desc_upper:
                        txn_type = "interest"
                    elif valor > 0:
                        txn_type = "transfer_in"
                    else:
                        txn_type = "payment"

                    txns.append({
                        "date": txn_date,
                        "amount": valor,
                        "merchant": description[:300],
                        "type": txn_type,
                        "balance": saldo,
                        "account_last4": "7666",
                    })
                
                i = j
            else:
                i += 1

    finally:
        os.unlink(tmp_path)

    return txns


def main():
    # Connect to postgres
    conn = psycopg2.connect(DB_DSN)
    cur = conn.cursor()

    # Connect to IMAP
    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(IMAP_USER, IMAP_PASS)
    mail.select('"Ozzu/Finance"')

    # Find all statement emails
    status, data = mail.search(None, 'FROM "extractos"')
    ids = data[0].split() if data[0] else []
    print(f"Statement emails found: {len(ids)}")

    total_inserted = 0
    total_parsed = 0
    
    for msg_id in ids:
        status, msg_data = mail.fetch(msg_id, "(RFC822)")
        msg = email.message_from_bytes(msg_data[0][1])
        subj = msg.get("Subject", "")
        from_ = msg.get("From", "")
        msg_date = msg.get("Date", "")
        
        for part in msg.walk():
            fn = part.get_filename() or ""
            if not fn.lower().endswith(".pdf"):
                continue
            
            pdf_data = part.get_payload(decode=True)
            if not pdf_data:
                continue

            # Extract year hint from filename like "202506" or "202112"
            year_m = re.search(r'_(\d{4})\d{2}_', fn)
            year_hint = int(year_m.group(1)) if year_m else None

            print(f"\n📄 {fn} (year_hint={year_hint})")
            txns = parse_statement_pdf(pdf_data, year_hint)
            print(f"   Parsed: {len(txns)} transactions")
            total_parsed += len(txns)

            for txn in txns:
                email_uid = f"pdf_{fn}_{txn['date']}_{txn['amount']}"
                try:
                    cur.execute("""
                        INSERT INTO transactions
                          (date, amount, merchant, type, account_last4, balance, source, email_uid)
                        VALUES (%s, %s, %s, %s, %s, %s, 'pdf_statement', %s)
                        ON CONFLICT (email_uid) DO NOTHING
                    """, (
                        txn["date"], txn["amount"], txn["merchant"],
                        txn["type"], txn["account_last4"], txn.get("balance"),
                        email_uid
                    ))
                    if cur.rowcount > 0:
                        total_inserted += 1
                except Exception as e:
                    print(f"   DB error: {e}")

            conn.commit()

    mail.logout()
    cur.close()
    conn.close()

    print(f"\n✅ Done: {total_parsed} parsed, {total_inserted} new transactions inserted")

if __name__ == "__main__":
    main()
