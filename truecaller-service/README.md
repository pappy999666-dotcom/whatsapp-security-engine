# Truecaller Microservice

Local Flask microservice used by the bot's `.getdv` command. It wraps the
Truecaller search endpoint and returns clean JSON metadata that the bot pairs
with the target's WhatsApp profile picture to build an **Intel Card**.

## Run

```bash
cd truecaller-service
pip install -r requirements.txt

# Set your Truecaller bearer token (recommended over hardcoding it in app.py)
export TRUECALLER_TOKEN="your_truecaller_bearer_token"

python app.py
```

The service listens on `http://0.0.0.0:5000`.

## Endpoint

```
GET /truecaller?number=<phone_number>
```

Example:

```bash
curl "http://localhost:5000/truecaller?number=919876543210"
```

Returns:

```json
{
  "name": "...",
  "phone": "+91...",
  "carrier": "...",
  "email": "...",
  "gender": "...",
  "city": "...",
  "country": "IN",
  "image": "https://...",
  "isFraud": false
}
```

## How the bot connects

The `.getdv` command (in `plugins/pappy-getdv.js`) calls this service at the URL
defined by the `TRUECALLER_API_URL` environment variable, defaulting to
`http://localhost:5000/truecaller`. Start this service **before** using `.getdv`.
