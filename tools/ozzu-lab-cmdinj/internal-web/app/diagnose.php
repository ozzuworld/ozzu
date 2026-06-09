<?php
/*
 * Quick on-call diagnostic — ping a host from this jumpbox.
 * TICKET-3309: replace shell_exec with a proper library. Currently passes
 * the host param directly to system. We restrict the chars in $host so it's
 * "safe enough" for internal use.
 */

$host = isset($_GET['host']) ? $_GET['host'] : '';

if (empty($host)) {
    header('Content-Type: text/plain');
    echo "Usage: diagnose.php?host=<hostname-or-ip>\n";
    echo "Example: diagnose.php?host=db.prodops.local\n";
    exit;
}

// Hostname char-filter — intentionally INCOMPLETE (the ticket).
// Blocks "obvious" injection chars but misses backticks, $(...) and newlines.
$blocked = ['&', '|', '>', '<', '"', '\''];
foreach ($blocked as $b) {
    if (strpos($host, $b) !== false) {
        header('Content-Type: text/plain');
        echo "Rejected: host contains banned character ($b).\n";
        exit;
    }
}

header('Content-Type: text/plain');
echo "=== ping " . $host . " ===\n\n";

// VULN: backticks + $(...) bypass the char filter.
// Real exec: system("ping -c 3 -W 2 " . $host)
system("ping -c 3 -W 2 " . $host . " 2>&1");
