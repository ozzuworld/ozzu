<!DOCTYPE html>
<html>
<head><title>ProdOps Network Diagnostics</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 20px; }
h1 { color: #cc2236; }
.tile { border-left: 3px solid #cc2236; padding: 12px 16px; margin: 18px 0; background: #fff5f5; }
code { background: #f4f6f8; padding: 2px 5px; border-radius: 3px; }
.devnote { background:#f4f6f8; padding:14px; border-left:3px solid #cc2236; margin-top:30px; font-size:0.9em; }
</style></head>
<body>
<h1>ProdOps Network Diagnostics</h1>
<p>On-call quick tools for the production ops squad. Use these to verify connectivity from this jumpbox.</p>

<div class="tile">
<strong>Diagnose host:</strong>
<form action="diagnose.php" method="get">
  Target host: <input type="text" name="host" placeholder="db.prodops.local" size="30">
  <button>Ping</button>
</form>
Example: <code>diagnose.php?host=db.prodops.local</code>
</div>

<div class="tile">
<strong>Lookup record:</strong>
<form action="lookup.php" method="get">
  DNS name: <input type="text" name="name" placeholder="edge-gw.prodops.local" size="30">
  <button>Lookup</button>
</form>
</div>

<div class="devnote">
<strong>Internal note:</strong> diagnose.php just shells out to <code>ping</code>. We know that's gross — there's a TICKET-3309 to swap it for a proper library. Until then, please don't paste user-typed input into the host field from prod tickets. (We mostly use this from inside the LAN anyway.)
</div>
</body>
</html>
