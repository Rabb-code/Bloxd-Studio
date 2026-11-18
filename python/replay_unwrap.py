# replay_unwrap.py
# ============================================================
# 形式9 以上のリプレイ(2026-10 のアップデートから)の包みをほどく。読むだけ。
#   ファイル = [形式の番号 4バイト] [nonce 12バイト] [ChaCha20 で暗号化した raw deflate]
#   ほどいた中身は、形式7 と同じ Avro(公式の表でも 7・8・9 は同じ形)。
#   先頭の 4 バイトを付け直して返すので、そのまま前の読み方(r.pos = 4)で読める。
# 形式8 以下はそのまま返す。
# 暗号に戻す(Bloxd のリプレイとして保存する)機能は、わざと作っていない。
# ============================================================
import struct
import zlib

import numpy as np

# 公式の鍵(形式9)。公式の JS の中にある 32 バイト
_KEYS = {
    9: bytes.fromhex('c351564ea9b2eba3d72eeaa299f37b7e9c00af71a4928df175bd386dc166c550'),
}
_NONCE_LEN = 12


def _rotl(v, n):
    return (v << np.uint32(n)) | (v >> np.uint32(32 - n))


def _chacha20_xor(key, nonce, data, counter=1):
    """ChaCha20(RFC 8439)。numpy で全部のブロックを一度に計算する"""
    n_blocks = (len(data) + 63) // 64
    if n_blocks == 0:
        return b''
    const = np.frombuffer(b'expand 32-byte k', dtype='<u4')
    k = np.frombuffer(key, dtype='<u4')
    nw = np.frombuffer(nonce, dtype='<u4')
    st = np.empty((16, n_blocks), dtype=np.uint32)
    st[0:4] = const[:, None]
    st[4:12] = k[:, None]
    st[12] = (np.arange(n_blocks, dtype=np.uint64) + counter).astype(np.uint32)
    st[13:16] = nw[:, None]
    x = [st[i].copy() for i in range(16)]

    def qr(a, b, c, d):
        x[a] += x[b]; x[d] = _rotl(x[d] ^ x[a], 16)
        x[c] += x[d]; x[b] = _rotl(x[b] ^ x[c], 12)
        x[a] += x[b]; x[d] = _rotl(x[d] ^ x[a], 8)
        x[c] += x[d]; x[b] = _rotl(x[b] ^ x[c], 7)

    with np.errstate(over='ignore'):
        for _ in range(10):
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        out = np.stack([x[i] + st[i] for i in range(16)])  # (16, n)
    stream = out.T.astype('<u4').tobytes()[:len(data)]
    a = np.frombuffer(data, dtype=np.uint8)
    b = np.frombuffer(stream, dtype=np.uint8)
    return (a ^ b).tobytes()


def unwrap_replay(data):
    """bytes → 前の形式と同じ並びの bytes(先頭4バイト + Avro)"""
    if len(data) < 4:
        raise ValueError('リプレイのファイルが短すぎます')
    ver = struct.unpack_from('<I', data, 0)[0]
    if ver < 9:
        return data
    key = _KEYS.get(ver)
    if key is None:
        raise ValueError(f'このリプレイの形式 {ver} にはまだ対応していません(Bloxd のアップデートで変わった可能性があります)')
    if len(data) < 4 + _NONCE_LEN:
        raise ValueError('リプレイのファイルが壊れているか、途中で切れています')
    nonce = data[4:4 + _NONCE_LEN]
    packed = _chacha20_xor(key, nonce, data[4 + _NONCE_LEN:])
    try:
        body = zlib.decompress(packed, -15)
    except zlib.error as e:
        raise ValueError(f'リプレイのファイルが壊れているか、途中で切れています({e})')
    return data[:4] + body
