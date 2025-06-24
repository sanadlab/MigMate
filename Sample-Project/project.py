import requests

# Simple GET request
req = requests.get("https://www.google.com")
print(req.status_code)

# GET with params + JSON parsing
resp = requests.get(
    "https://api.example.com/data",
    params={"q": "test", "limit": 5}
)
print(resp.json())

# POST request
with requests.Session() as session:
    post_resp = session.post(
        "https://api.example.com/submit",
        json={"key": "value"}
    )
    if post_resp.ok:
        print("Submitted!", post_resp.text)
    else:
        print("Error:", post_resp.status_code)