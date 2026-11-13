#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_video.py —— 视频内容抽取：语音转写 + 关键帧

由 web-reader 插件的 lib/video.mjs 调用；输出**单行 JSON**（stdout 最后一行是结果）。

依赖（缺了会给结构化错误，不会崩）：
    python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp imageio-ffmpeg faster-whisper

用法：
    python extract_video.py --url <url> --out <dir> [--frames 6] [--start 0] [--end 120]
                            [--model small] [--lang zh] [--asr 1|0] [--no-cache]

模型走国内镜像时设置：
    HF_ENDPOINT=https://hf-mirror.com
    HF_HUB_DISABLE_XET=1
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time


def emit(obj):
    """结果必须是最后一行，前面的人类日志走 stderr。"""
    print(json.dumps(obj, ensure_ascii=False))


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def _slug(s, n=60):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", s or "video").strip("_ ")
    return s[:n] or "video"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default="_video_out")
    ap.add_argument("--frames", type=int, default=0, help="抽多少张关键帧，0=不抽")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float, default=0, help="0=到结尾")
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--asr", type=int, default=1)
    ap.add_argument("--cookie", default="", help="Cookie 头原始字符串")
    ap.add_argument("--width", type=int, default=960)
    a = ap.parse_args(argv)

    t0 = time.time()
    try:
        import yt_dlp
        import imageio_ffmpeg
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": "missing_deps", "detail": f"{type(e).__name__}: {e}",
              "hint": "pip install yt-dlp imageio-ffmpeg faster-whisper"})
        return 0

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs(a.out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="wr_video_")

    base_opts = {
        "quiet": True, "no_warnings": True, "noprogress": True,
        "retries": 5, "socket_timeout": 30, "noplaylist": True,
        "ffmpeg_location": ffmpeg,
        "http_headers": {
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
            "Referer": "https://www.bilibili.com/",
        },
    }
    # 登录态能显著降低 B 站对视频流的频控（直接用 Cookie 头，避免 Netscape 文件格式问题）
    if a.cookie:
        base_opts["http_headers"]["Cookie"] = a.cookie

    result = {"ok": True, "url": a.url, "frames": [], "transcript": "", "srt": "",
              "language": "", "model": a.model, "elapsed": 0}
    try:
        # 1) 元数据
        with yt_dlp.YoutubeDL(base_opts) as ydl:
            info = ydl.extract_info(a.url, download=False)
        title = info.get("title") or "video"
        dur = float(info.get("duration") or 0)
        result.update({"title": title, "duration": dur, "uploader": info.get("uploader") or ""})
        slug = _slug(title)

        # 2) 抽帧（先做，快）
        if a.frames > 0:
            fmt = "bv*[height<=720]/b[height<=720]/bv*+ba/b"
            vopts = dict(base_opts, format=fmt, outtmpl=os.path.join(tmp, "v.%(ext)s"))
            with yt_dlp.YoutubeDL(vopts) as ydl:
                ydl.extract_info(a.url, download=True)
            src = None
            for f in os.listdir(tmp):
                if f.startswith("v."):
                    src = os.path.join(tmp, f)
            if src:
                start = max(0.0, a.start or 0.0)
                end = a.end or min(dur or (start + 60), start + 600)
                span = max(1.0, end - start)
                step = span / max(1, a.frames)
                for i in range(a.frames):
                    t = start + step * i
                    p = os.path.join(a.out, f"{slug}_{int(t):05d}s.jpg")
                    try:
                        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-ss", str(t),
                                        "-i", src, "-frames:v", "1",
                                        "-vf", f"scale={a.width}:-2", p],
                                       check=True, timeout=60)
                        result["frames"].append(p)
                    except Exception as e:  # noqa: BLE001
                        log(f"frame {t}s failed: {e}")

        # 3) 语音转写
        if a.asr:
            try:
                from faster_whisper import WhisperModel
            except Exception as e:  # noqa: BLE001
                result["asr_error"] = f"faster-whisper 不可用：{e}"
                raise StopIteration
            aopts = dict(base_opts, format="bestaudio/best",
                         outtmpl=os.path.join(tmp, "audio.%(ext)s"))
            with yt_dlp.YoutubeDL(aopts) as ydl:
                ydl.extract_info(a.url, download=True)
            raw = None
            for f in os.listdir(tmp):
                if f.startswith("audio."):
                    raw = os.path.join(tmp, f)
            if not raw:
                result["asr_error"] = "音频下载失败"
                raise StopIteration

            wav = os.path.join(tmp, "a16k.wav")
            cmd = [ffmpeg, "-y", "-loglevel", "error"]
            if a.start:
                cmd += ["-ss", str(a.start)]
            cmd += ["-i", raw]
            if a.end:
                cmd += ["-t", str(max(0.1, a.end - (a.start or 0)))]
            cmd += ["-ac", "1", "-ar", "16000", "-vn", wav]
            subprocess.run(cmd, check=True, timeout=300)

            import wave
            import numpy as np
            with wave.open(wav, "rb") as w:
                pcm = w.readframes(w.getnframes())
            audio = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0

            model = WhisperModel(a.model, device="cpu", compute_type="int8",
                                 download_root=os.environ.get("WR_MODEL_DIR") or None)
            segs, meta = model.transcribe(audio, language=a.lang or None, vad_filter=True, beam_size=5)
            lines, srt = [], []
            for i, s in enumerate(segs, 1):
                lines.append(s.text.strip())

                def ts(t):
                    h, r = divmod(t, 3600)
                    m, sec = divmod(r, 60)
                    return f"{int(h):02d}:{int(m):02d}:{sec:06.3f}".replace(".", ",")
                srt.append(f"{i}\n{ts(s.start)} --> {ts(s.end)}\n{s.text.strip()}\n")
            text = "\n".join(lines)
            result["transcript"] = text
            result["language"] = getattr(meta, "language", "") or ""
            tp = os.path.join(a.out, slug + ".txt")
            sp = os.path.join(a.out, slug + ".srt")
            with open(tp, "w", encoding="utf-8") as f:
                f.write(text)
            with open(sp, "w", encoding="utf-8") as f:
                f.write("\n".join(srt))
            result.update({"transcript_path": tp, "srt_path": sp, "chars": len(text)})
    except StopIteration:
        pass
    except Exception as e:  # noqa: BLE001
        result.update({"ok": False, "error": "extract_failed", "detail": f"{type(e).__name__}: {e}"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    result["elapsed"] = round(time.time() - t0, 1)
    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
