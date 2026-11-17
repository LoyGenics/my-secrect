# Test-only mail plumbing for the throwaway stacks (docker-compose.test.yml).
# Source it; it defines functions only. Nothing here is used in production.

# mail_tls DIR : a CA and a server certificate for host name `mailpit`, valid
# for 2 days, created for this run only. Writes DIR/{ca.crt,mailpit.crt,mailpit.key};
# the CA key is deleted right after signing, so nothing else can be issued.
mail_tls() {
  local d=$1
  mkdir -p "$d"
  cat >"$d/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = mailpit
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:mailpit
authorityKeyIdentifier = keyid
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$d/openssl.cnf" -extensions ca \
    -subj '/CN=my-secrect throwaway test mail CA' -keyout "$d/ca.key" -out "$d/ca.crt" 2>/dev/null
  openssl req -new -newkey rsa:2048 -nodes -config "$d/openssl.cnf" \
    -keyout "$d/mailpit.key" -out "$d/mailpit.csr" 2>/dev/null
  openssl x509 -req -in "$d/mailpit.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -CAcreateserial -days 2 \
    -extfile "$d/openssl.cnf" -extensions leaf -out "$d/mailpit.crt" 2>/dev/null
  rm -f "$d/ca.key" "$d/mailpit.csr" "$d/ca.srl" "$d/openssl.cnf"
  # Readable by Mailpit inside its container (throwaway key, temp dir).
  chmod 644 "$d/ca.crt" "$d/mailpit.crt" "$d/mailpit.key"
  [ -s "$d/mailpit.crt" ] || { echo "FAIL: could not create the test mail certificate" >&2; return 1; }
}

# mail_env DIR MAILPIT_HTTP_PORT : env-file lines for the test override.
mail_env() {
  cat <<ENV
SMTP_ADDRESS=mailpit
SMTP_PORT=1025
SMTP_USERNAME=test-smtp
SMTP_PASSWORD=$(openssl rand -hex 16)
MAIL_FROM=no-reply@localhost
MAIL_TLS_DIR=$1
MAILPIT_HTTP_PORT=$2
ENV
}
