<!DOCTYPE html>
<html>
<head><title>Skyline Internal Portal</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
h1 { color: #1a5490; }
ul { line-height: 1.8; }
a { color: #1a5490; text-decoration: none; }
a:hover { text-decoration: underline; }
.docnote { background:#f4f6f8; padding:14px; border-left:3px solid #1a5490; margin-top:30px; font-size:0.9em; }
</style></head>
<body>
<h1>Skyline Internal Portal</h1>
<p>Operations document viewer. Browse SOPs and runbooks for the logistics platform.</p>
<h3>Available documents</h3>
<ul>
  <li><a href="view.php?file=sop-db-014.txt">SOP-DB-014 — Database access procedure</a></li>
  <li><a href="view.php?file=runbook-deploy.txt">Runbook — Deployment process</a></li>
  <li><a href="view.php?file=incident-template.txt">Incident response template</a></li>
  <li><a href="view.php?file=onboarding.txt">Engineer onboarding</a></li>
</ul>
<div class="docnote">
<strong>Internal note:</strong> The view.php tool is a quick utility while we finish the doc-management rewrite. Path validation is on the TODO list for Q3.
</div>
</body>
</html>
