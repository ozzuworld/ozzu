# OzzuLab SSTI training target — intentionally renders user input as a template (training only)
from flask import Flask, request, render_template_string
app = Flask(__name__)
@app.route('/')
def greet():
    name = request.args.get('name', 'guest')
    return render_template_string("<h1>Welcome, " + name + "</h1><p>Account portal</p>")
app.run(host='0.0.0.0', port=80)
