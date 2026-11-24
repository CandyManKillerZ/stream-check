package main

// The Windows native layer. All check logic lives in the shared web core
// (web/core.js); Go only provides what a web page cannot do on its own:
// cross-origin HTTP, TCP pings, speed tests and DPAPI-encrypted storage.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const userAgent = "StreamCheck/1.3 (+https://github.com/CandyManKillerZ/stream-check)"

type App struct{ ctx context.Context }

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go cleanupOldExe() // leftovers from a previous self-update (update.go)
}

var client = &http.Client{
	Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConnsPerHost: 4,
		ForceAttemptHTTP2:   true,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	},
}

type HTTPRequest struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
}

type HTTPResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
	Ms     int    `json:"ms"`
	Error  string `json:"error"`
}

// HTTP performs one request. Failures come back as a short readable string
// in Error, never as a thrown error. Bodies are capped at 32 MB (an
// AIOStreams raw search with duplicate removal off can return thousands of results).
func (a *App) HTTP(r HTTPRequest) HTTPResponse {
	if !strings.HasPrefix(r.URL, "https://") && !strings.HasPrefix(r.URL, "http://") {
		return HTTPResponse{Error: "bad URL"}
	}
	if r.TimeoutMs <= 0 {
		r.TimeoutMs = 15000
	}
	if r.Method == "" {
		r.Method = "GET"
	}
	ctx, cancel := context.WithTimeout(a.ctx, time.Duration(r.TimeoutMs)*time.Millisecond)
	defer cancel()
	var body io.Reader
	if r.Body != "" {
		body = strings.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return HTTPResponse{Error: "bad URL"}
	}
	req.Header.Set("User-Agent", userAgent)
	for k, v := range r.Headers {
		req.Header.Set(k, v)
	}
	t0 := time.Now()
	res, err := client.Do(req)
	if err != nil {
		return HTTPResponse{Error: friendlyErr(err), Ms: int(time.Since(t0).Milliseconds())}
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	out := HTTPResponse{Status: res.StatusCode, Body: string(b), Ms: int(time.Since(t0).Milliseconds())}
	if err != nil {
		out.Error = friendlyErr(err)
	}
	return out
}

type PingResult struct {
	Ms    int    `json:"ms"`
	Error string `json:"error"`
}

// TCPPing times opening a TCP connection (ICMP is filtered by most CDNs).
func (a *App) TCPPing(host string, port int, timeoutMs int) PingResult {
	t0 := time.Now()
	c, err := (&net.Dialer{Timeout: time.Duration(timeoutMs) * time.Millisecond}).DialContext(a.ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return PingResult{Ms: -1, Error: friendlyErr(err)}
	}
	c.Close()
	ms := int(time.Since(t0).Milliseconds())
	if ms < 1 {
		ms = 1
	}
	return PingResult{Ms: ms}
}

type SpeedResult struct {
	ID    string  `json:"id"`
	Mbps  float64 `json:"mbps"`
	MB    float64 `json:"mb"`
	Error string  `json:"error"`
}

// SpeedTest downloads from rawURL for up to `seconds`, emitting "speed"
// progress events, and returns the average throughput.
func (a *App) SpeedTest(id, rawURL string, seconds int) SpeedResult {
	res := SpeedResult{ID: id}
	if _, err := url.ParseRequestURI(rawURL); err != nil {
		res.Error = "bad URL"
		return res
	}
	ctx, cancel := context.WithTimeout(a.ctx, time.Duration(seconds+6)*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	req.Header.Set("User-Agent", userAgent)
	r, err := client.Do(req)
	if err != nil {
		res.Error = friendlyErr(err)
		return res
	}
	defer r.Body.Close()
	if r.StatusCode >= 400 {
		res.Error = fmt.Sprintf("HTTP %d", r.StatusCode)
		return res
	}
	buf := make([]byte, 256<<10)
	var total int64
	start, last := time.Now(), time.Now()
	limit := time.Duration(seconds) * time.Second
	for {
		n, err := r.Body.Read(buf)
		total += int64(n)
		el := time.Since(start)
		if time.Since(last) > 250*time.Millisecond {
			last = time.Now()
			runtime.EventsEmit(a.ctx, "speed", SpeedResult{ID: id, Mbps: float64(total*8) / el.Seconds() / 1e6, MB: float64(total) / 1e6})
		}
		if err == io.EOF || el > limit {
			break
		}
		if err != nil {
			if total == 0 {
				res.Error = friendlyErr(err)
			}
			break
		}
	}
	if el := time.Since(start).Seconds(); el > 0 {
		res.Mbps = float64(total*8) / el / 1e6
	}
	res.MB = float64(total) / 1e6
	return res
}

func (a *App) StoreGet(key string) string { return storeGet(key) }

func (a *App) StoreSet(key, value string) error { return storeSet(key, value) }

func (a *App) OpenURL(u string) {
	if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		runtime.BrowserOpenURL(a.ctx, u)
	}
}

func friendlyErr(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "domain not found (DNS)"
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "Client.Timeout") || strings.Contains(s, "i/o timeout"):
		return "timed out"
	case strings.Contains(s, "refused"):
		return "connection refused"
	case strings.Contains(s, "reset"):
		return "connection reset"
	case strings.Contains(s, "tls:") || strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
		return "secure connection failed (TLS)"
	case strings.Contains(s, "EOF"):
		return "connection closed by server"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return s
}
