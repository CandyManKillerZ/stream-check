package main

// Settings live in %APPDATA%\StreamCheck\config.json as a flat key → value
// map. Every value is encrypted with Windows DPAPI (CryptProtectData), so the
// file is useless on another PC or under another Windows account. Values
// written by v1.0 in plain text (server URL, UUID, mode) are still read.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var storeMu sync.Mutex

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "StreamCheck", "config.json")
}

func readStore() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func writeStore(m map[string]string) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

func storeGet(key string) string {
	storeMu.Lock()
	defer storeMu.Unlock()
	raw := readStore()[key]
	if raw == "" {
		return ""
	}
	if plain, ok := unprotect(raw); ok {
		return plain
	}
	return raw // v1.0 plain-text value
}

func storeSet(key, value string) error {
	storeMu.Lock()
	defer storeMu.Unlock()
	m := readStore()
	if value == "" {
		delete(m, key)
	} else {
		enc, err := protect(value)
		if err != nil {
			return err
		}
		m[key] = enc
	}
	return writeStore(m)
}

func protect(plain string) (string, error) {
	b := []byte(plain)
	in := windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	enc := make([]byte, out.Size)
	copy(enc, unsafe.Slice(out.Data, out.Size))
	return base64.StdEncoding.EncodeToString(enc), nil
}

func unprotect(enc string) (string, bool) {
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(b) == 0 {
		return "", false
	}
	in := windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", false
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(unsafe.Slice(out.Data, out.Size)), true
}
