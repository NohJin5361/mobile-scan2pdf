"""Command line entry point: ``python -m scan2pdf [--https] [--port 8000]``.

Phone browsers only allow camera access on HTTPS (or localhost). ``--https`` creates a
self-signed certificate in the data directory so the app can be opened from a phone on
the same Wi-Fi network (accept the certificate warning once).
"""

from __future__ import annotations

import argparse
import ipaddress
import socket
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import Settings


def _local_ips() -> list[str]:
    ips = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def ensure_self_signed(cert_dir: Path) -> tuple[Path, Path]:
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert, key = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    names = ["localhost", *_local_ips()]
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        pkey = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Scan2PDF local")])
        alt = [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in names[1:]]
        now = datetime.now(timezone.utc)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(pkey.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .sign(pkey, hashes.SHA256())
        )
        key.write_bytes(pkey.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
        cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    except ImportError:
        san = ",".join(["DNS:localhost"] + [f"IP:{ip}" for ip in names[1:]])
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
             "-keyout", str(key), "-out", str(cert), "-subj", "/CN=Scan2PDF local", "-addext", f"subjectAltName={san}"],
            check=True, capture_output=True,
        )
    return cert, key


def main() -> None:
    parser = argparse.ArgumentParser(prog="scan2pdf", description="Scan2PDF server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--https", action="store_true", help="serve over HTTPS with a self-signed certificate")
    parser.add_argument("--cert", help="TLS certificate (PEM)")
    parser.add_argument("--key", help="TLS private key (PEM)")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    import uvicorn

    ssl = {}
    if args.cert and args.key:
        ssl = {"ssl_certfile": args.cert, "ssl_keyfile": args.key}
    elif args.https:
        cert, key = ensure_self_signed(Settings().data_dir / "certs")
        ssl = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    scheme = "https" if ssl else "http"
    print(f"\n  Scan2PDF: {scheme}://localhost:{args.port}")
    for ip in _local_ips():
        print(f"            {scheme}://{ip}:{args.port}   (phone on the same Wi-Fi)")
    print()
    uvicorn.run("scan2pdf.main:create_app", factory=True, host=args.host, port=args.port, reload=args.reload, **ssl)


if __name__ == "__main__":
    main()
