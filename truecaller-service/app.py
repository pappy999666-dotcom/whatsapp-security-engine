from flask import Flask, request, jsonify
import os
import requests

app = Flask(__name__)


def safe_first(lst, key=None):
    if lst and len(lst) > 0:
        return lst[0].get(key) if key else lst[0]
    return None


def fetch_truecaller(number):
    # Prefer an environment variable so the token never has to live in source control.
    TOKEN = os.environ.get("TRUECALLER_TOKEN", "REPLACE_WITH_YOUR_TRUECALLER_BEARER_TOKEN")
    url = f"https://search5-noneu.truecaller.com/v2/search?q={number}&countryCode=IN&type=4&encoding=json"
    headers = {
        "User-Agent": "Truecaller/15.32.6 (Android;14)",
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "Authorization": f"Bearer {TOKEN}",
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        data = res.json()
        info = data.get("data", [{}])[0]
        return {
            "name": info.get("name"),
            "phone": safe_first(info.get("phones"), "e164Format"),
            "carrier": safe_first(info.get("phones"), "carrier"),
            "email": safe_first(info.get("internetAddresses"), "id"),
            "gender": info.get("gender"),
            "city": safe_first(info.get("addresses"), "city"),
            "country": safe_first(info.get("addresses"), "countryCode"),
            "image": info.get("image"),
            "isFraud": info.get("isFraud", False),
        }
    except Exception as e:
        return {"error": str(e)}


@app.route("/truecaller", methods=["GET"])
def truecaller_api():
    number = request.args.get("number")
    if not number:
        return jsonify({"error": "Missing number parameter"}), 400
    return jsonify(fetch_truecaller(number))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
