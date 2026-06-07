<?php
/*
 * Quick doc viewer — used by ops to browse SOPs.
 * TODO(eng-onboarding): Add path validation. Currently allows arbitrary file paths
 * because the docs/ directory was supposed to be jailed by Apache config, but that
 * was deferred. Track in TICKET-2401.
 */

$file = isset($_GET['file']) ? $_GET['file'] : '';

if (empty($file)) {
    echo "Usage: view.php?file=&lt;docname&gt;";
    exit;
}

// VULN: no sanitization, no prefix lock-down. Direct include.
$path = "/var/www/html/docs/" . $file;

header('Content-Type: text/plain');
echo "=== Viewing: " . $file . " ===\n\n";

if (file_exists($path)) {
    readfile($path);
} else {
    // Convenience: try absolute path too. (this is the LFI vector)
    if (file_exists($file)) {
        readfile($file);
    } else {
        echo "File not found.\n";
    }
}
