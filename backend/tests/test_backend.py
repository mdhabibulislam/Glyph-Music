"""Metadata parsing, input validation, matching, and the full MP3 + ZIP pipeline."""
from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from mutagen.id3 import ID3
from mutagen.mp3 import MP3

from app import spotify
from app.audio import plan_bitrate
from app.library import norm
from app.security import ensure_within, is_allowed_image_url, parse_spotify_url, safe_filename
from app.zipstream import stream_zip

from conftest import ORIGIN

H = {"Origin": ORIGIN}
PID = "37i9dQZF1DXcBWIGoYBM5M"


# ------------------------------------------------------------------ validation
@pytest.mark.parametrize("url,expected", [
    (f"https://open.spotify.com/playlist/{PID}", ("playlist", PID)),
    (f"https://open.spotify.com/playlist/{PID}?si=abc123", ("playlist", PID)),
    (f"https://open.spotify.com/intl-de/album/{PID}", ("album", PID)),
    (f"spotify:track:{PID}", ("track", PID)),
])
def test_spotify_links_are_parsed(url, expected):
    assert parse_spotify_url(url) == expected


@pytest.mark.parametrize("url", [
    "http://open.spotify.com/playlist/" + PID,                 # not https
    "https://open.spotify.com.evil.example/playlist/" + PID,   # look-alike host
    "https://evil.example/https://open.spotify.com/playlist/" + PID,
    "https://open.spotify.com@127.0.0.1/playlist/" + PID,      # credentials trick
    "https://open.spotify.com/playlist/../../etc/passwd",
    "http://127.0.0.1:8787/api/settings", "http://169.254.169.254/latest/meta-data", "file:///C:/Windows/win.ini",
    "https://open.spotify.com/show/" + PID, "https://open.spotify.com/playlist/short", "", "javascript:alert(1)",
])
def test_ssrf_and_malformed_links_are_rejected(url):
    with pytest.raises(ValueError):
        parse_spotify_url(url)


def test_fetch_endpoint_rejects_non_spotify_urls(authed):
    r = authed.post("/api/playlist/fetch", json={"url": "http://127.0.0.1:8787/api/health"}, headers=H)
    assert r.status_code == 422 and r.json()["code"] == "bad_url"


def test_artwork_is_only_fetched_from_spotify_image_hosts():
    assert is_allowed_image_url("https://i.scdn.co/image/ab67616d0000b273abc")
    for bad in ("http://i.scdn.co/image/x", "https://i.scdn.co.evil.example/x", "https://127.0.0.1/x",
                "https://user@i.scdn.co/x", "https://i.scdn.co:8443/x", "file:///etc/passwd", None, ""):
        assert not is_allowed_image_url(bad)


def test_filenames_are_sanitised():
    assert safe_filename('AC/DC - Back: "In" Black?') == "AC DC - Back In Black"
    assert safe_filename("..\\..\\Windows\\system32") == "Windows system32"
    assert safe_filename("CON") == "_CON"
    assert safe_filename("   ...   ") == "untitled"
    assert "/" not in safe_filename("a/b") and "\\" not in safe_filename("a\\b")


def test_path_traversal_is_blocked(tmp_path):
    base = tmp_path / "downloads"
    base.mkdir()
    assert ensure_within(base, base / "song.mp3") == (base / "song.mp3").resolve()
    for bad in (base / ".." / "secret.txt", base / "a" / ".." / ".." / "x", tmp_path / "other"):
        with pytest.raises(ValueError):
            ensure_within(base, bad)


def test_job_ids_must_be_well_formed(authed):
    for bad in ("..%2F..%2Fglyph.db", "A" * 32, "abc", "a" * 33):
        assert authed.get(f"/api/jobs/{bad}").status_code == 404


# ------------------------------------------------------------------ metadata
def _embed(entity: dict) -> str:
    data = {"props": {"pageProps": {"state": {"data": {"entity": entity}}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


def test_embed_page_is_parsed_into_tracks():
    html = _embed({
        "type": "playlist", "name": "My Favourite Songs", "subtitle": "habibul",
        "coverArt": {"sources": [{"url": "https://i.scdn.co/image/small", "width": 64},
                                 {"url": "https://i.scdn.co/image/large", "width": 640},
                                 {"url": "https://evil.example/huge", "width": 9999}]},
        "trackList": [
            {"uri": "spotify:track:" + "A" * 22, "title": "First Song", "subtitle": "Artist One, Artist Two", "duration": 201000},
            {"uri": "spotify:track:" + "B" * 22, "title": "Second Song", "subtitle": "Solo", "duration": 180000, "isPlayable": False},
            {"uri": "spotify:track:" + "A" * 22, "title": "First Song", "subtitle": "Artist One, Artist Two", "duration": 201000},
        ]})
    p = spotify.parse_embed_html(html, "playlist", PID)
    spotify.mark_duplicates(p)
    assert p["name"] == "My Favourite Songs" and p["cover_url"] == "https://i.scdn.co/image/large"
    assert [t["title"] for t in p["tracks"]] == ["First Song", "Second Song", "First Song"]
    assert p["tracks"][0]["artists"] == ["Artist One", "Artist Two"] and p["tracks"][0]["duration_ms"] == 201000
    assert p["tracks"][2]["duplicate_of"] == 0 and p["tracks"][1]["duplicate_of"] is None


def test_unreadable_embed_page_explains_the_fallback():
    with pytest.raises(spotify.MetadataError) as e:
        spotify.parse_embed_html("<html>nothing here</html>", "playlist", PID)
    assert "CSV" in str(e.value)


def test_csv_import_accepts_exportify_and_plain_files():
    exportify = ('"Track URI","Track Name","Album Name","Artist Name(s)","Duration (ms)"\n'
                 f'"spotify:track:{"C" * 22}","Sunrise Tone","Test Signals","The Testers","3000"\n'
                 f'"spotify:track:{"D" * 22}","Low Hum (Remastered)","","Sine Collective, Guest","4000"\n')
    p = spotify.import_csv(exportify, "Morning Mix.csv", 100)
    assert p["name"] == "Morning Mix" and len(p["tracks"]) == 2
    assert p["tracks"][1]["artists"] == ["Sine Collective", "Guest"] and p["tracks"][1]["duration_ms"] == 4000
    plain = spotify.import_csv("Title;Artist;Duration\nSong;Someone;3:25\n", "", 100)
    assert plain["tracks"][0]["duration_ms"] == 205000 and plain["name"] == "Imported playlist"
    with pytest.raises(spotify.MetadataError):
        spotify.import_csv("foo,bar\n1,2\n", "x", 100)


def test_matching_normalisation():
    assert norm("Beyoncé – Halo (feat. Someone) [Live]") == norm("beyonce halo")
    assert norm("Song Title - 2011 Remastered Version") == "song title"
    assert norm("(Intro)") == "intro"


def test_bitrate_plan_never_upscales_lossy_sources():
    assert plan_bitrate("flac", 900_000, True, 320) == (320, False)   # lossless: use the chosen quality
    assert plan_bitrate("mp3", 128_000, False, 320) == (128, True)    # MP3: keep the original untouched
    assert plan_bitrate("aac", 128_000, False, 320) == (128, False)   # other lossy: don't inflate
    assert plan_bitrate("mp3", 320_000, False, 128) == (128, False)   # downsizing is honoured
    assert plan_bitrate("vorbis", 250_000, False, 320) == (256, False)


def test_zip_stream_is_valid_and_incremental(tmp_path):
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * (3 * 1024 * 1024))
    chunks = list(stream_zip([("a/big.bin", big), ("note.txt", "héllo".encode())]))
    assert len(chunks) > 3, "large files must be emitted in pieces, not buffered whole"
    with zipfile.ZipFile(io.BytesIO(b"".join(chunks))) as zf:
        assert zf.testzip() is None
        assert zf.read("note.txt").decode() == "héllo" and len(zf.read("a/big.bin")) == 3 * 1024 * 1024


# ------------------------------------------------------------------ end-to-end pipeline
CSV = ('Track Name,Artist Name(s),Album Name,Duration (ms)\n'
       'Sunrise Tone,The Testers,Test Signals,3000\n'
       'Low Hum,Sine Collective,,4000\n'
       'A Song I Do Not Own,Nobody,,200000\n'
       'Sunrise Tone,The Testers,Test Signals,3000\n')


def _wait(client, job_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/api/jobs/{job_id}").json()["job"]
        if not job["running"]:
            return job
        time.sleep(0.15)
    raise AssertionError("job did not finish in time")


@pytest.fixture
def imported(authed, app, music_library):
    r = authed.put("/api/settings", json={"library_folders": [str(music_library)]}, headers=H)
    assert r.status_code == 200
    app.state.library.scan_blocking()
    r = authed.post("/api/playlist/import-csv", json={"name": "My Favourite Songs", "csv": CSV}, headers=H)
    assert r.status_code == 200
    return r.json()


def test_library_matching_and_availability(imported):
    job = imported["job"]
    assert [t["available"] for t in job["tracks"]] == [True, True, False, False]
    assert job["summary"]["available"] == 2 and job["summary"]["unavailable"] == 1 and job["summary"]["duplicates"] == 1
    assert imported["playlist"]["tracks"][3]["duplicate_of"] == 0
    assert imported["estimates"]["320"] > imported["estimates"]["128"] > 0


def test_full_download_produces_tagged_mp3s_and_a_zip(authed, imported):
    job_id = imported["playlist"]["id"]
    r = authed.post(f"/api/jobs/{job_id}/start", json={"indexes": None, "quality": 320}, headers=H)
    assert r.status_code == 200 and r.json()["queued"] == 2
    job = _wait(authed, job_id)
    assert [t["status"] for t in job["tracks"]] == ["completed", "completed", "unavailable", "idle"]
    assert job["summary"]["percent"] == 100.0 and job["summary"]["bytes_total"] > 0

    # Individual MP3: real audio, correct tags, honest bitrate.
    r = authed.get(f"/api/jobs/{job_id}/tracks/0/file")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
    assert "The Testers - Sunrise Tone.mp3" in r.headers["content-disposition"]
    folder = Path(imported["folder"])
    first = folder / "The Testers - Sunrise Tone.mp3"
    info = MP3(str(first)).info
    assert 2.5 < info.length < 3.6 and round(info.bitrate / 1000) == 320
    tags = ID3(str(first))
    assert str(tags["TIT2"]) == "Sunrise Tone" and str(tags["TPE1"]) == "The Testers"
    assert str(tags["TALB"]) == "Test Signals" and str(tags["TRCK"]) == "1"
    # The 128 kbps MP3 source is kept as-is rather than "upgraded" to 320.
    assert job["tracks"][1]["bitrate"] == 128 and "kept as-is" in job["tracks"][1]["note"]

    # ZIP: named after the playlist, contains only finished songs plus the three reports.
    link = authed.get(f"/api/jobs/{job_id}/zip-link").json()
    assert link["name"] == "My Favourite Songs.zip" and link["url"] == f"/api/jobs/{job_id}/zip"
    r = authed.get(link["url"])
    assert r.status_code == 200 and "My Favourite Songs.zip" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert zf.testzip() is None
        assert sorted(zf.namelist()) == sorted([
            "The Testers - Sunrise Tone.mp3", "Sine Collective - Low Hum.mp3",
            "Playlist.m3u", "Playlist.csv", "Download-report.txt"])
        assert zf.read("The Testers - Sunrise Tone.mp3") == first.read_bytes()
        assert "A Song I Do Not Own" in zf.read("Download-report.txt").decode()
        assert "Sine Collective - Low Hum.mp3" in zf.read("Playlist.m3u").decode()

    # Starting again does not repeat finished work.
    assert authed.post(f"/api/jobs/{job_id}/start", json={"quality": 320}, headers=H).json()["queued"] == 0

    # History is recorded in SQLite and can be deleted along with the files.
    items = authed.get("/api/history").json()["items"]
    assert items[0]["id"] == job_id and items[0]["completed"] == 2 and items[0]["total"] == 4
    assert authed.delete(f"/api/history/{job_id}?files=true", headers=H).status_code == 200
    assert authed.get("/api/history").json()["items"] == [] and not folder.exists()
    assert authed.get(f"/api/jobs/{job_id}/zip").status_code == 404


def test_downloads_need_a_session_even_when_files_exist(authed, client, imported):
    job_id = imported["playlist"]["id"]
    authed.post(f"/api/jobs/{job_id}/start", json={"quality": 192}, headers=H)
    _wait(authed, job_id)
    authed.cookies.clear()
    for path in (f"/api/jobs/{job_id}/zip", f"/api/jobs/{job_id}/tracks/0/file", f"/api/jobs/{job_id}/events"):
        assert authed.get(path).status_code == 401


def test_signed_link_is_issued_in_remote_mode(tmp_path, music_library):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from conftest import CODE, make_settings

    app = create_app(make_settings(tmp_path / "remote", public_backend_url="https://music.example.test"))
    c = TestClient(app)
    c.post("/api/auth/login", json={"code": CODE})
    c.put("/api/settings", json={"library_folders": [str(music_library)]}, headers=H)
    app.state.library.scan_blocking()
    job_id = c.post("/api/playlist/import-csv", json={"name": "Remote", "csv": CSV}, headers=H).json()["playlist"]["id"]
    c.post(f"/api/jobs/{job_id}/start", json={"quality": 128}, headers=H)
    _wait(c, job_id)
    url = c.get(f"/api/jobs/{job_id}/zip-link").json()["url"]
    assert url.startswith("https://music.example.test/api/dl/")
    c.cookies.clear()  # the signed link works on its own, briefly, for this one job
    r = c.get(url.replace("https://music.example.test", ""))
    assert r.status_code == 200 and zipfile.ZipFile(io.BytesIO(r.content)).testzip() is None
    app.state.db.close()


def test_cancel_and_retry(authed, app, imported, monkeypatch):
    from app import audio

    job_id = imported["playlist"]["id"]
    real = audio.convert_to_mp3

    def slow(ffmpeg, src, dst, kbps, duration, on_progress, cancel):
        for _ in range(100):
            if cancel.is_set():
                raise audio.Cancelled()
            time.sleep(0.05)
        real(ffmpeg, src, dst, kbps, duration, on_progress, cancel)

    monkeypatch.setattr(audio, "convert_to_mp3", slow)
    authed.post(f"/api/jobs/{job_id}/start", json={"indexes": [0], "quality": 320}, headers=H)
    time.sleep(0.5)
    assert authed.post(f"/api/jobs/{job_id}/cancel", headers=H).json()["cancelling"] is True
    job = _wait(authed, job_id)
    assert job["tracks"][0]["status"] == "cancelled"
    assert not list((app.state.settings.data_dir / "tmp").rglob("*.part")), "partial files must be cleaned up"

    monkeypatch.setattr(audio, "convert_to_mp3", real)
    assert authed.post(f"/api/jobs/{job_id}/retry", json={"quality": 320}, headers=H).json()["queued"] == 1
    assert _wait(authed, job_id)["tracks"][0]["status"] == "completed"


def test_corrupt_source_fails_cleanly(authed, app, tmp_path):
    lib = tmp_path / "badlib"
    lib.mkdir()
    # Looks like audio to the scanner's database, but FFmpeg can't decode it.
    bad = lib / "Broken - Noise.wav"
    bad.write_bytes(b"RIFF" + b"\x00" * 4096)
    app.state.db.execute(
        "INSERT INTO library(path,mtime,size,title,artist,album,duration,bitrate,codec,lossless) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (str(bad), 0, bad.stat().st_size, "Noise", "Broken", "", 5.0, 1411000, "wav", 1))
    app.state.library._reload()
    pid = authed.post("/api/playlist/import-csv", json={"name": "Bad", "csv": "Title,Artist\nNoise,Broken\n"},
                      headers=H).json()["playlist"]["id"]
    authed.post(f"/api/jobs/{pid}/start", json={"quality": 320}, headers=H)
    job = _wait(authed, pid)
    assert job["tracks"][0]["status"] == "failed" and job["tracks"][0]["error"]
    assert authed.get(f"/api/jobs/{pid}/zip").status_code == 409  # nothing valid to archive


def test_settings_validation(authed, tmp_path):
    assert authed.put("/api/settings", json={"default_quality": 999}, headers=H).status_code == 422
    assert authed.put("/api/settings", json={"max_concurrent": 50}, headers=H).status_code == 422
    assert authed.put("/api/settings", json={"library_folders": ["relative/path"]}, headers=H).status_code == 422
    assert authed.put("/api/settings", json={"library_folders": [str(tmp_path / "missing")]}, headers=H).status_code == 422
    r = authed.put("/api/settings", json={"default_quality": 192, "auto_zip": False}, headers=H).json()
    assert r["default_quality"] == 192 and r["auto_zip"] is False
