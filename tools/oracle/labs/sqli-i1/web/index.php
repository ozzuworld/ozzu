<?php // OzzuLab SQLi training target — intentionally vulnerable, training use only
$c=@new mysqli("10.10.30.30","webuser","webpass","appdb");
if($c->connect_errno){http_response_code(500);echo "db down";exit;}
$id=isset($_GET['id'])?$_GET['id']:'1';
$res=$c->query("SELECT name,descr FROM products WHERE id=".$id);
echo "<h1>Product Catalog</h1>";
if($res){while($r=$res->fetch_assoc()){echo htmlspecialchars($r['name'])." - ".htmlspecialchars($r['descr'])."<br>";}}
else{echo "DB error: ".htmlspecialchars($c->error);}
