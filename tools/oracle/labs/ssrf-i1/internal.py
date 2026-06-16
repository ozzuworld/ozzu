#!/usr/bin/env python3
# Internal-only metadata service for ssrf-i1. Bound to 127.0.0.1:8080 so it is reachable
# ONLY from inside the container (i.e. only via the public app's SSRF), never directly from
# the attacker. Holds the flag. Mimics a cloud-metadata / internal-admin endpoint.
from flask import Flask

app = Flask(__name__)


@app.route("/")
def home():
    return "internal metadata service (instance-local). endpoints: /latest /flag"


@app.route("/latest")
def latest():
    return "instance-id: i-0ab12\nregion: lab-1\nrole: app-internal\n"


@app.route("/flag")
def flag():
    return "internal metadata service\nsecret: OZZULAB{ssrf_i1_internal_metadata_2026}\n"


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8080)
