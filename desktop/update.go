package main

// Self-updater for the Windows app (the web UI decides WHEN; see web/ui.js).
//
//   DownloadUpdate  fetches the new .exe from this project's GitHub release
//                   into the app's own folder and verifies its SHA-256 against
//                   the digest GitHub publishes for the asset.
//   InstallUpdate   swaps the files — a running .exe can be renamed but not
//                   overwritten — starts the new version and quits.
//   startup         deletes the previous version's leftover "*.old" file.
//
// Only URLs from this repository's releases are accepted, and nothing is
// installed unless the checksum matches.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const releaseDownloadPrefix = "https://github.com/CandyManKillerZ/stream-check/releases/download/"

type UpdateResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

func exePaths() (exe, download, old string, err error) {
	exe, err = os.Executable()
	if err != nil {
		return
	}
	if r, e := filepath.EvalSymlinks(exe); e == nil {
		exe = r
	}
	return exe, exe + ".download", exe + ".old", nil
}

// cleanupOldExe removes what a previous update left behind.
func cleanupOldExe() {
	if _, dl, old, err := exePaths(); err == nil {
		_ = os.Remove(old)
		_ = os.Remove(dl)
	}
}

func (a *App) DownloadUpdate(url, sha string) UpdateResult {
	sha = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(sha), "sha256:"))
	if !strings.HasPrefix(url, releaseDownloadPrefix) || !strings.HasSuffix(strings.ToLower(url), ".exe") {
		return UpdateResult{Error: "refusing to download an update from outside the Stream Check releases"}
	}
	if len(sha) != 64 {
		return UpdateResult{Error: "the release has no SHA-256 checksum, so the update cannot be verified"}
	}
	_, dl, _, err := exePaths()
	if err != nil {
		return UpdateResult{Error: err.Error()}
	}
	f, err := os.Create(dl)
	if err != nil {
		return UpdateResult{Error: "Stream Check cannot write to its own folder (" + filepath.Dir(dl) + ") — download the update manually"}
	}
	fail := func(msg string) UpdateResult { f.Close(); os.Remove(dl); return UpdateResult{Error: msg} }

	req, _ := http.NewRequestWithContext(a.ctx, "GET", url, nil)
	req.Header.Set("User-Agent", userAgent)
	dlClient := &http.Client{Timeout: 10 * time.Minute}
	res, err := dlClient.Do(req)
	if err != nil {
		return fail("download failed: " + friendlyErr(err))
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fail(fmt.Sprintf("download failed: HTTP %d", res.StatusCode))
	}
	h := sha256.New()
	total := res.ContentLength
	var got int64
	buf := make([]byte, 256<<10)
	last := time.Now()
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return fail("could not save the update: " + werr.Error())
			}
			h.Write(buf[:n])
			got += int64(n)
			if time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				runtime.EventsEmit(a.ctx, "update-progress", map[string]any{"got": got, "total": total})
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return fail("download interrupted: " + friendlyErr(rerr))
		}
	}
	if err := f.Close(); err != nil {
		return fail("could not save the update: " + err.Error())
	}
	if hex.EncodeToString(h.Sum(nil)) != sha {
		os.Remove(dl)
		return UpdateResult{Error: "the download does not match the release checksum — nothing was installed"}
	}
	runtime.EventsEmit(a.ctx, "update-progress", map[string]any{"got": got, "total": got})
	return UpdateResult{OK: true}
}

func (a *App) InstallUpdate() UpdateResult {
	exe, dl, old, err := exePaths()
	if err != nil {
		return UpdateResult{Error: err.Error()}
	}
	if _, err := os.Stat(dl); err != nil {
		return UpdateResult{Error: "no downloaded update found — download it again"}
	}
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return UpdateResult{Error: "could not replace the running version: " + err.Error()}
	}
	if err := os.Rename(dl, exe); err != nil {
		_ = os.Rename(old, exe) // put the working version back
		return UpdateResult{Error: "could not install the update: " + err.Error()}
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return UpdateResult{Error: "updated, but could not restart — open Stream Check again: " + err.Error()}
	}
	go func() { time.Sleep(300 * time.Millisecond); runtime.Quit(a.ctx) }()
	return UpdateResult{OK: true}
}
