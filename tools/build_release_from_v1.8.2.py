#!/usr/bin/env python3
from pathlib import Path
import argparse
import hashlib
import os
import shutil
import struct
import subprocess
import tempfile
import zipfile
import zlib

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, pkcs12

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE = ROOT / 'tools' / 'base-v1.8.2.apk'
DEFAULT_OUTPUT = ROOT / 'dist' / '不爱刷题_v2.0.7.apk'
CUSTOM_DEX = ROOT / 'tools' / 'classes-v2.0.3.dex'

def load_local_signing_properties():
    props = {}
    prop_file = ROOT / 'signing' / 'signing.properties'
    if not prop_file.is_file():
        return props
    for raw in prop_file.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        props[key.strip()] = value.strip()
    return props

_LOCAL_SIGNING = load_local_signing_properties()
KEYSTORE_VALUE = os.environ.get('BUAIQUIZ_KEYSTORE', '').strip() or _LOCAL_SIGNING.get('keystore', '')
if KEYSTORE_VALUE and not Path(KEYSTORE_VALUE).is_absolute():
    KEYSTORE = (ROOT / KEYSTORE_VALUE).resolve()
else:
    KEYSTORE = Path(KEYSTORE_VALUE).expanduser().resolve() if KEYSTORE_VALUE else None
PASSWORD = os.environ.get('BUAIQUIZ_STORE_PASSWORD', '') or _LOCAL_SIGNING.get('storePassword', '')
KEY_PASSWORD = os.environ.get('BUAIQUIZ_KEY_PASSWORD', '') or _LOCAL_SIGNING.get('keyPassword', '') or PASSWORD
ALIAS = os.environ.get('BUAIQUIZ_KEY_ALIAS', '') or _LOCAL_SIGNING.get('keyAlias', '')
VERSION_NAME = '2.0.7'
VERSION_CODE = 207
V2_ID = 0x7109871A
V3_ID = 0xF05368C0
PADDING_ID = 0x42726577
ALG_ID = 0x0104  # RSA PKCS#1 v1.5 + SHA-512
V3_MIN_SDK = 24
V3_MAX_SDK = 0x7FFFFFFF
STRIPPING_PROTECTION_ATTR_ID = 0xBEEFF00D


def lp32(data: bytes) -> bytes:
    return struct.pack('<I', len(data)) + data


def patch_manifest(data: bytes) -> bytes:
    old_version = '1.8.2'.encode('utf-16le')
    new_version = VERSION_NAME.encode('utf-16le')
    if len(old_version) != len(new_version):
        raise RuntimeError('versionName length must remain unchanged for binary AXML patching')
    if data.count(old_version) != 1:
        raise RuntimeError(f'unexpected v1.8.2 string count: {data.count(old_version)}')
    out = bytearray(data.replace(old_version, new_version))
    version_code_offset = 1716
    old_code = struct.unpack_from('<I', out, version_code_offset)[0]
    if old_code != 182:
        raise RuntimeError(f'unexpected base versionCode: {old_code}')
    struct.pack_into('<I', out, version_code_offset, VERSION_CODE)
    return bytes(out)


def make_zipinfo(source: zipfile.ZipInfo, name: str | None = None) -> zipfile.ZipInfo:
    zi = zipfile.ZipInfo(name or source.filename, date_time=(1980, 1, 1, 0, 0, 0))
    zi.compress_type = source.compress_type
    zi.create_system = 0
    zi.external_attr = source.external_attr
    zi.internal_attr = source.internal_attr
    zi.comment = b''
    return zi



def build_raw_unsigned(base_apk: Path, output: Path) -> None:
    assets = ROOT / 'app' / 'src' / 'main' / 'assets' / 'web'
    required = ['base.css', 'index.html', 'project-data.js', 'project-modules.js',
                'question-ai-model.js', 'runtime.js', 'theme.css']
    missing = [name for name in required if not (assets / name).is_file()]
    if missing:
        raise RuntimeError(f'missing web assets: {missing}')
    asset_files = sorted(path for path in assets.rglob('*') if path.is_file())
    with zipfile.ZipFile(base_apk, 'r') as base, zipfile.ZipFile(output, 'w', allowZip64=False) as out:
        for info in base.infolist():
            name = info.filename
            if name.startswith('META-INF/') or name.startswith('assets/web/'):
                continue
            raw = base.read(name)
            if name == 'AndroidManifest.xml':
                raw = patch_manifest(raw)
            elif name == 'classes.dex':
                if not CUSTOM_DEX.is_file():
                    raise RuntimeError(f'custom classes.dex missing: {CUSTOM_DEX}')
                raw = CUSTOM_DEX.read_bytes()
            zi = make_zipinfo(info)
            out.writestr(zi, raw, compress_type=info.compress_type, compresslevel=9)
        # Replace the complete web business layer and the normally recompiled native DEX; resources remain from the verified base APK.
        for source in asset_files:
            relative = source.relative_to(assets).as_posix()
            raw = source.read_bytes()
            zi = zipfile.ZipInfo(f'assets/web/{relative}', date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 0
            zi.external_attr = 0
            out.writestr(zi, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def align_extra(current_offset: int, filename: str) -> bytes:
    name_bytes = filename.encode('utf-8')
    base_data_offset = current_offset + 30 + len(name_bytes)
    pad = (-base_data_offset) % 4
    # Android zipalign extra field: 0xd935, payload starts with alignment value, then pad bytes.
    payload = struct.pack('<I', 4) + (b'\0' * pad)
    return struct.pack('<HH', 0xD935, len(payload)) + payload


def rebuild_aligned(v1_input: Path, output: Path) -> None:
    with zipfile.ZipFile(v1_input, 'r') as source, zipfile.ZipFile(output, 'w', allowZip64=False) as out:
        for info in source.infolist():
            raw = source.read(info.filename)
            zi = make_zipinfo(info)
            if info.compress_type == zipfile.ZIP_STORED:
                zi.extra = align_extra(out.fp.tell(), info.filename)
            else:
                zi.extra = b''
            out.writestr(zi, raw, compress_type=info.compress_type, compresslevel=9)


def load_key_cert(work: Path):
    p12 = work / 'release.p12'
    subprocess.run([
        'keytool', '-importkeystore', '-noprompt',
        '-srckeystore', str(KEYSTORE), '-srcstorepass', PASSWORD, '-srcalias', ALIAS,
        '-destkeystore', str(p12), '-deststoretype', 'PKCS12',
        '-deststorepass', PASSWORD, '-destkeypass', KEY_PASSWORD
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    key, cert, _ = pkcs12.load_key_and_certificates(p12.read_bytes(), PASSWORD.encode())
    if key is None or cert is None:
        raise RuntimeError('failed to load release key/certificate')
    return key, cert


def content_digest(apk: bytes, signing_block_offset: int, central_dir_offset: int, eocd_offset: int) -> bytes:
    eocd = bytearray(apk[eocd_offset:])
    struct.pack_into('<I', eocd, 16, signing_block_offset)
    chunk_digests = []
    for section in (apk[:signing_block_offset], apk[central_dir_offset:eocd_offset], bytes(eocd)):
        for start in range(0, len(section), 1024 * 1024):
            chunk = section[start:start + 1024 * 1024]
            h = hashlib.sha512()
            h.update(b'\xA5' + struct.pack('<I', len(chunk)) + chunk)
            chunk_digests.append(h.digest())
    h = hashlib.sha512()
    h.update(b'\x5A' + struct.pack('<I', len(chunk_digests)) + b''.join(chunk_digests))
    return h.digest()


def pair(identifier: int, value: bytes) -> bytes:
    return struct.pack('<Q', len(value) + 4) + struct.pack('<I', identifier) + value


def build_v2_value(digest: bytes, key, cert) -> bytes:
    digest_record = struct.pack('<I', ALG_ID) + lp32(digest)
    digests = lp32(digest_record)
    certificates = lp32(cert.public_bytes(Encoding.DER))
    attr_record = struct.pack('<II', STRIPPING_PROTECTION_ATTR_ID, 3)
    attributes = lp32(attr_record)
    signed_data = lp32(digests) + lp32(certificates) + lp32(attributes)
    signature = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA512())
    signatures = lp32(struct.pack('<I', ALG_ID) + lp32(signature))
    public_key = cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    signer = lp32(signed_data) + lp32(signatures) + lp32(public_key)
    return lp32(lp32(signer))


def build_v3_value(digest: bytes, key, cert) -> bytes:
    digest_record = struct.pack('<I', ALG_ID) + lp32(digest)
    digests = lp32(digest_record)
    certificates = lp32(cert.public_bytes(Encoding.DER))
    attributes = b''
    signed_data = (
        lp32(digests) + lp32(certificates)
        + struct.pack('<II', V3_MIN_SDK, V3_MAX_SDK)
        + lp32(attributes)
    )
    signature = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA512())
    signatures = lp32(struct.pack('<I', ALG_ID) + lp32(signature))
    public_key = cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    signer = (
        lp32(signed_data)
        + struct.pack('<II', V3_MIN_SDK, V3_MAX_SDK)
        + lp32(signatures) + lp32(public_key)
    )
    return lp32(lp32(signer))


def add_v2_v3(aligned_v1: Path, output: Path, key, cert) -> None:
    apk = aligned_v1.read_bytes()
    eocd_offset = apk.rfind(b'PK\x05\x06')
    if eocd_offset < 0:
        raise RuntimeError('EOCD not found')
    central_dir_offset = struct.unpack_from('<I', apk, eocd_offset + 16)[0]
    if apk.rfind(b'APK Sig Block 42', 0, central_dir_offset) >= 0:
        raise RuntimeError('input already contains APK signing block')
    digest = content_digest(apk, central_dir_offset, central_dir_offset, eocd_offset)
    pairs = pair(V2_ID, build_v2_value(digest, key, cert)) + pair(V3_ID, build_v3_value(digest, key, cert))
    # Match the proven v1.8.2 8 KiB signing block, including Android's verity padding pair.
    fixed_total = 8192
    fixed_overhead = 8 + len(pairs) + 8 + 16
    padding_pair_total = fixed_total - fixed_overhead
    if padding_pair_total < 12:
        raise RuntimeError('signing pairs exceed fixed block size')
    padding_value_len = padding_pair_total - 12
    pairs += pair(PADDING_ID, b'\0' * padding_value_len)
    block_size = len(pairs) + 24
    signing_block = struct.pack('<Q', block_size) + pairs + struct.pack('<Q', block_size) + b'APK Sig Block 42'
    if len(signing_block) != fixed_total:
        raise RuntimeError(f'unexpected signing block size: {len(signing_block)}')
    out = bytearray()
    out += apk[:central_dir_offset]
    out += signing_block
    out += apk[central_dir_offset:eocd_offset]
    eocd = bytearray(apk[eocd_offset:])
    struct.pack_into('<I', eocd, 16, central_dir_offset + len(signing_block))
    out += eocd
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(out)


def read_lp(data: bytes, offset: int = 0):
    length = struct.unpack_from('<I', data, offset)[0]
    end = offset + 4 + length
    if end > len(data):
        raise RuntimeError('invalid length-prefixed field')
    return data[offset + 4:end], end


def signing_pairs(apk: bytes):
    eocd = apk.rfind(b'PK\x05\x06')
    cd = struct.unpack_from('<I', apk, eocd + 16)[0]
    if apk[cd - 16:cd] != b'APK Sig Block 42':
        raise RuntimeError('APK signing block magic missing')
    size = struct.unpack_from('<Q', apk, cd - 24)[0]
    start = cd - size - 8
    if struct.unpack_from('<Q', apk, start)[0] != size:
        raise RuntimeError('APK signing block size mismatch')
    current = start + 8
    end = cd - 24
    result = {}
    while current < end:
        length = struct.unpack_from('<Q', apk, current)[0]
        identifier = struct.unpack_from('<I', apk, current + 8)[0]
        result[identifier] = apk[current + 12:current + 8 + length]
        current += 8 + length
    if current != end:
        raise RuntimeError('APK signing pair boundary mismatch')
    return start, cd, eocd, result


def verify_signature_value(value: bytes, v3: bool, apk: bytes, block_start: int, cd: int, eocd: int):
    signers, _ = read_lp(value)
    signer, _ = read_lp(signers)
    signed_data, offset = read_lp(signer)
    if v3:
        min_sdk, max_sdk = struct.unpack_from('<II', signer, offset)
        offset += 8
        if (min_sdk, max_sdk) != (V3_MIN_SDK, V3_MAX_SDK):
            raise RuntimeError('V3 SDK range mismatch')
    signatures, offset = read_lp(signer, offset)
    public_key, offset = read_lp(signer, offset)
    if offset != len(signer):
        raise RuntimeError('unexpected signer trailing bytes')
    digests, cursor = read_lp(signed_data)
    certificates, cursor = read_lp(signed_data, cursor)
    if v3:
        min2, max2 = struct.unpack_from('<II', signed_data, cursor)
        cursor += 8
        if (min2, max2) != (V3_MIN_SDK, V3_MAX_SDK):
            raise RuntimeError('V3 signed SDK range mismatch')
    attributes, cursor = read_lp(signed_data, cursor)
    if cursor != len(signed_data):
        raise RuntimeError('unexpected signed-data trailing bytes')
    digest_record, _ = read_lp(digests)
    algorithm = struct.unpack_from('<I', digest_record, 0)[0]
    saved_digest, _ = read_lp(digest_record, 4)
    signature_record, _ = read_lp(signatures)
    signature_algorithm = struct.unpack_from('<I', signature_record, 0)[0]
    signature, _ = read_lp(signature_record, 4)
    cert_der, _ = read_lp(certificates)
    cert = x509.load_der_x509_certificate(cert_der)
    expected_pub = cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    if public_key != expected_pub:
        raise RuntimeError('public key mismatch')
    cert.public_key().verify(signature, signed_data, padding.PKCS1v15(), hashes.SHA512())
    calculated = content_digest(apk, block_start, cd, eocd)
    if algorithm != ALG_ID or signature_algorithm != ALG_ID or saved_digest != calculated:
        raise RuntimeError('APK content digest mismatch')
    if not v3:
        attr, end = read_lp(attributes)
        if end != len(attributes) or struct.unpack_from('<II', attr, 0) != (STRIPPING_PROTECTION_ATTR_ID, 3):
            raise RuntimeError('V2 stripping-protection attribute mismatch')
    elif attributes:
        raise RuntimeError('unexpected V3 attributes')
    return cert


def local_data_offset(apk: bytes, info: zipfile.ZipInfo) -> int:
    name_len = struct.unpack_from('<H', apk, info.header_offset + 26)[0]
    extra_len = struct.unpack_from('<H', apk, info.header_offset + 28)[0]
    return info.header_offset + 30 + name_len + extra_len


def validate(base_apk: Path, output: Path, allow_new_signer: bool = False) -> str:
    subprocess.run(['jarsigner', '-verify', str(output)], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    apk = output.read_bytes()
    block_start, cd, eocd, pairs = signing_pairs(apk)
    if set(pairs) != {V2_ID, V3_ID, PADDING_ID}:
        raise RuntimeError(f'unexpected signing block IDs: {[hex(x) for x in pairs]}')
    v2_cert = verify_signature_value(pairs[V2_ID], False, apk, block_start, cd, eocd)
    v3_cert = verify_signature_value(pairs[V3_ID], True, apk, block_start, cd, eocd)
    if v2_cert.fingerprint(hashes.SHA256()) != v3_cert.fingerprint(hashes.SHA256()):
        raise RuntimeError('V2/V3 certificate mismatch')
    with zipfile.ZipFile(output, 'r') as z, zipfile.ZipFile(base_apk, 'r') as base:
        bad = z.testzip()
        if bad:
            raise RuntimeError(f'bad ZIP entry: {bad}')
        required = {
            'AndroidManifest.xml', 'classes.dex', 'resources.arsc',
            'assets/web/index.html', 'assets/web/project-modules.js'
        }
        if not required.issubset(z.namelist()):
            raise RuntimeError('required APK entries missing')
        dex = z.read('classes.dex')
        expected_dex = CUSTOM_DEX.read_bytes()
        if dex != expected_dex:
            raise RuntimeError('classes.dex does not match the normally compiled v2.0.3 native layer reused by v2.0.7')
        if dex[12:32] != hashlib.sha1(dex[32:]).digest():
            raise RuntimeError('classes.dex SHA-1 signature mismatch')
        if struct.unpack_from('<I', dex, 8)[0] != (zlib.adler32(dex[12:]) & 0xffffffff):
            raise RuntimeError('classes.dex Adler-32 checksum mismatch')
        manifest = z.read('AndroidManifest.xml')
        if VERSION_NAME.encode('utf-16le') not in manifest:
            raise RuntimeError('versionName patch missing')
        if struct.unpack_from('<I', manifest, 1716)[0] != VERSION_CODE:
            raise RuntimeError('versionCode patch missing')
        for info in z.infolist():
            if info.compress_type == zipfile.ZIP_STORED:
                offset = local_data_offset(apk, info)
                if offset % 4:
                    raise RuntimeError(f'unaligned stored entry: {info.filename} at {offset}')
    output_fingerprint = v3_cert.fingerprint(hashes.SHA256()).hex()
    expected_fingerprint_file = ROOT / 'signing' / 'EXPECTED_CERT_SHA256.txt'
    if expected_fingerprint_file.is_file():
        expected = expected_fingerprint_file.read_text(encoding='utf-8').strip().replace(':', '').lower()
        if expected and output_fingerprint.lower() != expected:
            raise RuntimeError('release certificate differs from the stable signing certificate recorded in signing/EXPECTED_CERT_SHA256.txt')
    elif not allow_new_signer:
        base_apk_bytes = base_apk.read_bytes()
        base_start, base_cd, base_eocd, base_pairs = signing_pairs(base_apk_bytes)
        base_cert = verify_signature_value(base_pairs[V3_ID], True, base_apk_bytes, base_start, base_cd, base_eocd)
        if v3_cert.fingerprint(hashes.SHA256()) != base_cert.fingerprint(hashes.SHA256()):
            raise RuntimeError('release certificate differs from the base APK; provide the intended release keystore or use --allow-new-signer for a one-time signer transition')
    return output_fingerprint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-apk', default=str(DEFAULT_BASE))
    parser.add_argument('--output', default=str(DEFAULT_OUTPUT))
    parser.add_argument('--allow-new-signer', action='store_true',
                        help='allow a one-time signer transition only when no stable certificate fingerprint is recorded')
    args = parser.parse_args()
    base_apk = Path(args.base_apk).resolve()
    output = Path(args.output).resolve()
    if not base_apk.exists():
        raise SystemExit(f'base APK not found: {base_apk}')
    if KEYSTORE is None or not KEYSTORE.exists() or not PASSWORD or not KEY_PASSWORD or not ALIAS:
        raise SystemExit('release signing credentials are missing; set BUAIQUIZ_KEYSTORE, BUAIQUIZ_STORE_PASSWORD, BUAIQUIZ_KEY_ALIAS and BUAIQUIZ_KEY_PASSWORD')
    with tempfile.TemporaryDirectory(prefix='buaiquiz-v207-') as temp_dir:
        work = Path(temp_dir)
        raw = work / 'raw.apk'
        jarsigned = work / 'jarsigned.apk'
        aligned_v1 = work / 'aligned-v1.apk'
        build_raw_unsigned(base_apk, raw)
        subprocess.run([
            'jarsigner', '-keystore', str(KEYSTORE), '-storepass', PASSWORD, '-keypass', KEY_PASSWORD,
            '-sigalg', 'SHA384withRSA', '-digestalg', 'SHA-256',
            '-signedjar', str(jarsigned), str(raw), ALIAS
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        rebuild_aligned(jarsigned, aligned_v1)
        subprocess.run(['jarsigner', '-verify', str(aligned_v1)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        key, cert = load_key_cert(work)
        add_v2_v3(aligned_v1, output, key, cert)
    fingerprint = validate(base_apk, output, args.allow_new_signer)
    print(output)
    print('sha256=' + hashlib.sha256(output.read_bytes()).hexdigest())
    print('cert_sha256=' + fingerprint)


if __name__ == '__main__':
    main()
