Now we are making the PII layer broader for input guardrails, right now there is limited support like Email, phone number and credit card

We will add more PII below and use patterns plus structural validation for:

- Email addresses
- Phone numbers
- IP addresses
- API keys
- JWTs
- Private keys
- Cloud credentials
- Credit-card numbers
- National identifiers
- IBANs
- Database connection strings

Regex alone is insufficient. Add validators such as:

- Luhn checksum for card numbers
- Length and prefix validation
- IBAN checksum
- Entropy checks for secrets


