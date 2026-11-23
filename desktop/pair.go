package main

// Wi-Fi pairing: lets a phone copy this PC's sign-ins by scanning a QR code.
//
//   1. StartPairing opens a one-time HTTP listener on the LAN and returns a QR
//      code holding: LAN addresses, port, a random pairing id and a random
//      AES-256 key. The key never travels over the network.
//   2. The phone calls GET /hello?id=… to find a reachable address, then
//      POST /pair {id, device}. The PC shows "<device> wants to sign in".
//   3. Only after the user clicks Allow does the PC answer, with the sign-ins
//      encrypted (AES-256-GCM) under the key from the QR code.
//   4. The listener closes after one request, after Deny, or after 2 minutes.

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	pairPageURL  = "https://candymankillerz.github.io/stream-check/pair/"
	pairLifetime = 2 * time.Minute
	pairAnswerBy = 90 * time.Second
)

var secretKeys = []string{"torboxKey", "aioInstance", "aioUuid", "aioPassword", "aioManifestUrl", "aioMode"}

type pairSession struct {
	id       string
	key      []byte
	srv      *http.Server
	used     bool
	answer   chan bool
	closed   chan struct{}
	closeOne sync.Once
}

var (
	pairMu  sync.Mutex
	current *pairSession
)

type PairInfo struct {
	QR        string   `json:"qr"` // PNG data URL
	ExpiresAt string   `json:"expiresAt"`
	Hosts     []string `json:"hosts"`
	Error     string   `json:"error"`
}

type pairPayload struct {
	V int      `json:"v"`
	H []string `json:"h"`
	P int      `json:"p"`
	T string   `json:"t"`
	K string   `json:"k"`
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// StartPairing opens the one-time listener and returns the QR code.
func (a *App) StartPairing() PairInfo {
	a.StopPairing()
	hosts := lanAddresses()
	if len(hosts) == 0 {
		return PairInfo{Error: "This PC is not connected to a local network (no Wi-Fi or Ethernet address found)."}
	}
	ln, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		return PairInfo{Error: "Could not open a pairing port: " + err.Error()}
	}
	s := &pairSession{id: b64url(randBytes(16)), key: randBytes(32), answer: make(chan bool, 1), closed: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", s.hello)
	mux.HandleFunc("/pair", func(w http.ResponseWriter, r *http.Request) { s.pair(a, w, r) })
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	pairMu.Lock()
	current = s
	pairMu.Unlock()
	go s.srv.Serve(ln)

	port := ln.Addr().(*net.TCPAddr).Port
	p, _ := json.Marshal(pairPayload{V: 1, H: hosts, P: port, T: s.id, K: b64url(s.key)})
	link := pairPageURL + "#" + b64url(p)
	png, err := qrcode.Encode(link, qrcode.Medium, 512)
	if err != nil {
		s.close()
		return PairInfo{Error: "Could not draw the QR code: " + err.Error()}
	}
	expires := time.Now().Add(pairLifetime)
	go func() {
		select {
		case <-time.After(pairLifetime):
			if s.isUsed() {
				return // a phone is already asking; the request handler decides
			}
			runtime.EventsEmit(a.ctx, "pair", map[string]string{"state": "expired"})
			s.close()
		case <-s.closed:
		}
	}()
	return PairInfo{QR: "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), ExpiresAt: expires.Format(time.RFC3339), Hosts: hosts}
}

// AnswerPairing is the user's Allow / Deny click.
func (a *App) AnswerPairing(allow bool) {
	pairMu.Lock()
	s := current
	pairMu.Unlock()
	if s != nil {
		select {
		case s.answer <- allow:
		default:
		}
	}
}

func (a *App) StopPairing() {
	pairMu.Lock()
	s := current
	current = nil
	pairMu.Unlock()
	if s != nil {
		s.close()
	}
}

func (s *pairSession) close() {
	s.closeOne.Do(func() {
		close(s.closed)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(ctx)
	})
}

func (s *pairSession) isUsed() bool {
	pairMu.Lock()
	defer pairMu.Unlock()
	return s.used
}

func (s *pairSession) idOK(id string) bool {
	return subtle.ConstantTimeCompare([]byte(id), []byte(s.id)) == 1
}

func (s *pairSession) hello(w http.ResponseWriter, r *http.Request) {
	if !s.idOK(r.URL.Query().Get("id")) || s.isUsed() {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, 200, map[string]any{"app": "stream-check", "v": 1})
}

func (s *pairSession) pair(a *App, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req struct {
		ID     string `json:"id"`
		Device string `json:"device"`
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
	if json.Unmarshal(body, &req) != nil || !s.idOK(req.ID) {
		http.NotFound(w, r)
		return
	}
	pairMu.Lock()
	if s.used {
		pairMu.Unlock()
		writeJSON(w, 410, map[string]string{"error": "this QR code was already used"})
		return
	}
	s.used = true
	pairMu.Unlock()
	defer func() { go s.close() }()

	device := strings.TrimSpace(req.Device)
	if device == "" {
		device = "A phone"
	}
	if len([]rune(device)) > 60 {
		device = string([]rune(device)[:60])
	}
	runtime.EventsEmit(a.ctx, "pair", map[string]string{"state": "request", "device": device})

	var allow bool
	select {
	case allow = <-s.answer:
	case <-time.After(pairAnswerBy):
		runtime.EventsEmit(a.ctx, "pair", map[string]string{"state": "expired"})
		writeJSON(w, 403, map[string]string{"error": "nobody clicked Allow on the PC in time"})
		return
	case <-s.closed:
		writeJSON(w, 403, map[string]string{"error": "pairing was cancelled on the PC"})
		return
	}
	if !allow {
		runtime.EventsEmit(a.ctx, "pair", map[string]string{"state": "denied"})
		writeJSON(w, 403, map[string]string{"error": "the PC said no"})
		return
	}

	creds := map[string]string{}
	for _, k := range secretKeys {
		if v := storeGet(k); v != "" {
			creds[k] = v
		}
	}
	plain, _ := json.Marshal(creds)
	iv, ct, err := seal(s.key, plain)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "encryption failed"})
		return
	}
	writeJSON(w, 200, map[string]string{"iv": b64url(iv), "ct": b64url(ct)})
	runtime.EventsEmit(a.ctx, "pair", map[string]string{"state": "done", "device": device})
}

func seal(key, plain []byte) (iv, ct []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	iv = randBytes(gcm.NonceSize())
	return iv, gcm.Seal(nil, iv, plain, nil), nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// lanAddresses lists this PC's private IPv4 addresses on real network
// adapters (Wi-Fi / Ethernet), skipping VPN, WSL, Hyper-V and VM adapters.
func lanAddresses() []string {
	skip := []string{"vethernet", "wsl", "hyper-v", "virtualbox", "vmware", "docker", "loopback", "mullvad", "wireguard", "wg", "tun", "tap", "openvpn", "nordlynx", "tailscale", "zerotier", "vpn", "bluetooth"}
	type cand struct {
		ip    string
		score int
	}
	var out []cand
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(ifc.Name)
		bad := false
		for _, s := range skip {
			if strings.Contains(name, s) {
				bad = true
				break
			}
		}
		if bad {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, ad := range addrs {
			ipn, ok := ad.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			score := 1
			switch {
			case ip[0] == 192 && ip[1] == 168:
				score = 3
			case ip[0] == 10:
				score = 2
			}
			if strings.Contains(name, "wi-fi") || strings.Contains(name, "wlan") || strings.Contains(name, "wireless") || strings.Contains(name, "ethernet") {
				score += 2
			}
			out = append(out, cand{ip.String(), score})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	var ips []string
	for i, c := range out {
		if i == 3 {
			break
		}
		ips = append(ips, c.ip)
	}
	return ips
}
