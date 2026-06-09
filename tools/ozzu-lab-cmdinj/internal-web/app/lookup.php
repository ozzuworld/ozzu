<?php
/*
 * DNS lookup helper. Same intern who wrote diagnose.php wrote this.
 * Slightly different filter — for "consistency". Same kind of hole.
 */

$name = isset($_GET['name']) ? $_GET['name'] : '';

if (empty($name)) {
    header('Content-Type: text/plain');
    echo "Usage: lookup.php?name=<hostname>\n";
    exit;
}

// Filter: blocks pipes + redirects only.
$bad = ['|', '>', '<', '&'];
foreach ($bad as $b) {
    if (strpos($name, $b) !== false) {
        header('Content-Type: text/plain');
        echo "Rejected: name contains banned character ($b).\n";
        exit;
    }
}

header('Content-Type: text/plain');
echo "=== dig " . $name . " ===\n\n";

// VULN: backtick and ; not blocked.
system("dig +short " . $name . " 2>&1");
