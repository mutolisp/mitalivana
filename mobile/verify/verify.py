#!/usr/bin/env python3
"""Verify the provenance signature on a Mitalivana export.

    pip install cryptography          # the only dependency
    python3 verify.py export.zip      # a zip, or an unzipped folder
    python3 verify.py export.zip --orcid   # also ask orcid.org

Reads the zip directly (``zipfile`` is in the standard library), which is why
this one does not ask you to unzip first the way ``verify.mjs`` does.

Exit status: 0 everything checks out, 1 something did not, 2 wrong usage.

What a PASS means, exactly:

  * Every file the manifest lists is present and byte-for-byte what it was
    when the export was made.
  * The manifest -- including the name and ORCID it is attributed to -- was
    signed by whoever holds the private key matching the public key shown.

What it does NOT mean: that the data is correct, that it was collected when or
where it says, or that the ORCID account was not compromised.  With --orcid it
additionally confirms the key is published on that ORCID profile, which moves
the question to "does that researcher control their ORCID account" and no
further.  There is no certificate authority and no revocation; a signature
proves possession of a key, not the time of signing.

This is a deliberately independent implementation of the same checks as
``verify.mjs`` and ``verify.html``.  Three implementations that agree on a
fixture is the evidence that the format has no ambiguity in it -- which is why
the signature covers the manifest's raw bytes and not a re-serialisation of
them: there is no canonical-JSON rule here for the three to disagree about.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.request
import zipfile

SCHEMA = "mitalivana-signature/1"


def load_files(path: str) -> dict[str, bytes]:
    """Every file in the export, keyed by its path inside it."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}
    if not os.path.isdir(path):
        sys.exit(f"{path} is neither a zip nor a folder")
    out: dict[str, bytes] = {}
    for dirpath, _dirs, names in os.walk(path):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, path).replace(os.sep, "/")
            with open(full, "rb") as fh:
                out[rel] = fh.read()
    return out


def verify_ed25519(message: bytes, signature_hex: str, public_key_hex: str) -> bool:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        sys.exit("needs the 'cryptography' package:  pip install cryptography")
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))
        key.verify(bytes.fromhex(signature_hex), message)
        return True
    except (InvalidSignature, ValueError):
        # Bad signature, odd-length hex, wrong key length: all "does not verify".
        return False


def key_on_orcid_profile(orcid: str, public_key_hex: str) -> bool:
    """Is this key published on that ORCID profile?  Network, hence opt-in."""
    url = f"https://pub.orcid.org/v3.0/{orcid}/researcher-urls"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:  # noqa: S310 - fixed host
        body = json.load(res)
    # The key may sit in either half of a "Websites & social links" entry: the
    # label is free text, the URL field is validated as a URL.  Accepting both
    # means the researcher does not have to fight whichever one their ORCID
    # account rejects.
    haystack = "\n".join(
        part
        for u in body.get("researcher-url") or []
        for part in (u.get("url-name") or "", (u.get("url") or {}).get("value") or "")
    )
    return re.search(f"ed25519:{public_key_hex}", haystack, re.I) is not None


def main() -> int:
    args = [a for a in sys.argv[1:]]
    if not args or "-h" in args or "--help" in args:
        print("usage: python3 verify.py <export.zip | folder> [--orcid]", file=sys.stderr)
        return 2
    check_orcid = "--orcid" in args
    targets = [a for a in args if not a.startswith("-")]
    if len(targets) != 1:
        print("usage: python3 verify.py <export.zip | folder> [--orcid]", file=sys.stderr)
        return 2
    root = targets[0]

    files = load_files(root)
    manifests = sorted(
        p for p in files
        if p == "manifest.json" or p.endswith("/manifest.json") or p.endswith("bundle_manifest.json")
    )
    if not manifests:
        print(f"no manifest.json anywhere in {root} — is this a Mitalivana export?", file=sys.stderr)
        return 2

    bad = 0
    signed_count = 0
    print(f"Mitalivana export: {root}\n")

    for manifest_path in manifests:
        prefix = manifest_path[: manifest_path.rfind("/") + 1] if "/" in manifest_path else ""
        sig_path = prefix + "signature.json"
        print(manifest_path)

        manifest_bytes = files[manifest_path]
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            print("  ✗ manifest is not valid JSON\n")
            bad += 1
            continue

        listed = manifest.get("files") or []
        changed: list[str] = []
        missing: list[str] = []
        for f in listed:
            rel = prefix + f["path"]
            if rel not in files:
                missing.append(f["path"])
            elif hashlib.sha256(files[rel]).hexdigest() != f["sha256"]:
                changed.append(f["path"])

        if not listed:
            print("  – no file list in this manifest (exported before digests were added)")
        elif not changed and not missing:
            print(f"  ✓ files        {len(listed)} present and unchanged")
        else:
            bad += 1
            # Named individually and on purpose: "something changed" sends the
            # reader through the whole archive.  A photo that went through a
            # chat app or a cloud thumbnailer comes back re-encoded and lands
            # here -- a different problem from a broken signature, reported as
            # one.
            for p in changed:
                print(f"  ✗ changed      {p}")
            for p in missing:
                print(f"  ✗ missing      {p}")

        if sig_path not in files:
            print("  – unsigned (no signature.json beside this manifest)\n")
            continue
        signed_count += 1
        try:
            sig = json.loads(files[sig_path].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            print("  ✗ signature.json is not valid JSON\n")
            bad += 1
            continue
        if sig.get("schema") != SCHEMA:
            print(f'  ✗ signature    unknown format "{sig.get("schema")}" — this verifier speaks {SCHEMA}\n')
            bad += 1
            continue

        valid = verify_ed25519(manifest_bytes, sig.get("signature", ""), sig.get("public_key", ""))
        print(f'  {"✓" if valid else "✗"} signature    {"VALID" if valid else "INVALID"} (Ed25519)')
        if not valid:
            bad += 1

        by = manifest.get("signed_by") or {}
        if by.get("name"):
            print(f'    signer       {by["name"]}')
        if by.get("orcid"):
            print(f'    ORCID        {by["orcid"]}  https://orcid.org/{by["orcid"]}')
        print(f'    public key   ed25519:{sig.get("public_key")}')

        if by.get("public_key") and by["public_key"] != sig.get("public_key"):
            print("  ✗ the key in the manifest differs from the one that signed it")
            bad += 1

        if check_orcid and valid and by.get("orcid"):
            try:
                if key_on_orcid_profile(by["orcid"], sig["public_key"]):
                    print("  ✓ ORCID        this key is published on that profile")
                else:
                    print("  ✗ ORCID        this key is NOT on that profile — the attribution is unproven")
                    bad += 1
            except Exception as e:  # noqa: BLE001 - any network/parse failure is "could not check"
                print(f"  – ORCID        could not check ({e})")
        elif by.get("orcid") and not check_orcid:
            print("    ORCID        not checked — pass --orcid to confirm the key is published there")
        print()

    if signed_count == 0:
        print("This export carries no signature. Its files may still be listed and")
        print("digest-checked above, but nothing attributes them to anyone.")
    if bad:
        print(f"✗ {bad} problem(s) found.")
        return 1
    print("✓ Everything checks out.")
    print("  This shows the files are unaltered since export and who signed them.")
    print("  It does not vouch for the data itself, nor rule out a compromised ORCID account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
