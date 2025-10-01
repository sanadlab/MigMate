import requests

resp = requests.get("www.google.com")
assert resp.status_code == 200
