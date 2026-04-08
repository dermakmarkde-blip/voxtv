/**
 * ============================================================
 * MY BOX SMART — PLAYLIST M3U SÉCURISÉE + CONTRÔLE ÉCRANS
 * Cloudflare Pages Function : /functions/playlist.js
 *
 * Contrôle des écrans UNIFIÉ (site + IPTV = même compteur)
 * - appareils      = devices connectés via le site
 * - appareils_iptv = devices connectés via IPTV
 * - Total combiné vérifié contre max_ecrans
 *
 * Si max atteint → M3U d'erreur avec lien force=1
 * Si force=1     → efface tous les appareils IPTV et réenregistre
 *
 * ⚠️  SUPABASE_URL / SUPABASE_KEY correspondent au projet
 *     utilisé par index_vox.html (jkcityzwqvlppwasqsru).
 * ============================================================
 */

// ─── Supabase — même projet que index_vox.html ────────────────
const SUPABASE_URL = "https://jkcityzwqvlppwasqsru.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprY2l0eXp3cXZscHB3YXNxc3J1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTg1NDIsImV4cCI6MjA5MDg5NDU0Mn0.N2cxY-9SOKGqDQV4eTGz_Tdxa9zg3e5gQ1t79SMsS-U";

// ============================================================
// HELPERS
// ============================================================

function calcDaysLeft(user) {
    if (!user) return 0;
    if (user.duree === "VIE") return 9999;
    const total = parseInt(user.duree) || 0;
    if (total <= 0) return 0;
    if (!user.date_activation) return total;
    const act   = new Date(user.date_activation);
    const today = new Date();
    act.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.max(0, total - Math.floor((today - act) / 86_400_000));
}

function errResponse(msg, status, CORS) {
    return new Response(msg, {
        status,
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
    });
}

function generateDeviceId() {
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================
export async function onRequest(context) {
    const request = context.request;
    const reqUrl  = new URL(request.url);
    const params  = reqUrl.searchParams;
    const baseUrl = reqUrl.origin;

    const CORS = {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
    }

    const userKey     = (params.get("key")    || "").trim().toUpperCase();
    const category    = (params.get("cat")    || "").trim().toLowerCase();
    const search      = (params.get("search") || "").trim().toLowerCase();
    const format      = (params.get("format") || "m3u").toLowerCase();
    const existingDid = (params.get("did")    || "").trim();
    // force=1 → déconnecter tous les appareils IPTV et se reconnecter
    const force       = params.get("force") === "1";

    const sbHeaders = {
        "apikey":        SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type":  "application/json",
    };

    // ── 1. Clé obligatoire ────────────────────────────────────
    if (!userKey) {
        return errResponse("Clé manquante. Utilisez /playlist?key=VOTRE-CLE", 400, CORS);
    }

    // ── 2. Vérification abonnement ────────────────────────────
    let user = null;
    try {
        const authRes = await fetch(
            SUPABASE_URL + "/rest/v1/utilisateurs?cle=eq." +
            encodeURIComponent(userKey) +
            "&select=cle,duree,date_activation,max_ecrans,appareils,appareils_iptv&limit=1",
            { headers: sbHeaders }
        );
        if (!authRes.ok) return errResponse("Erreur serveur. Réessayez.", 503, CORS);

        const users = await authRes.json();
        if (!users || users.length === 0) {
            return errResponse("Clé invalide. Abonnez-vous sur myboxsmart.pages.dev", 403, CORS);
        }

        user = users[0];
        const daysLeft = calcDaysLeft(user);
        if (daysLeft <= 0 && user.duree !== "VIE") {
            return errResponse("Abonnement expiré. Renouvelez sur myboxsmart.pages.dev", 403, CORS);
        }
    } catch (_) {
        return errResponse("Erreur serveur temporaire. Réessayez.", 503, CORS);
    }

    // ── 3. Contrôle des écrans UNIFIÉ (site + IPTV) ───────────
    const maxScreens    = parseInt(user.max_ecrans) || 1;
    const appareilsSite = (user.appareils      || "").split(",").map(d => d.trim()).filter(Boolean);
    let   appareilsIptv = (user.appareils_iptv || "").split(",").map(d => d.trim()).filter(Boolean);

    // Total combiné sans doublons
    const allDevices = [...new Set([...appareilsSite, ...appareilsIptv])];

    let deviceId = "";

    if (existingDid && appareilsIptv.includes(existingDid)) {
        // ✅ Appareil IPTV déjà enregistré → retéléchargement simple
        deviceId = existingDid;

    } else if (force) {
        // ✅ Force → déconnecter tous les appareils IPTV et enregistrer un nouveau
        deviceId = generateDeviceId();
        try {
            await fetch(
                SUPABASE_URL + "/rest/v1/utilisateurs?cle=eq." + encodeURIComponent(userKey),
                {
                    method:  "PATCH",
                    headers: { ...sbHeaders, "Prefer": "return=minimal" },
                    body:    JSON.stringify({ appareils_iptv: deviceId }),
                }
            );
        } catch (_) {}

    } else if (allDevices.length < maxScreens) {
        // ✅ Place disponible → enregistrer le nouvel appareil IPTV
        deviceId = generateDeviceId();
        appareilsIptv.push(deviceId);
        try {
            await fetch(
                SUPABASE_URL + "/rest/v1/utilisateurs?cle=eq." + encodeURIComponent(userKey),
                {
                    method:  "PATCH",
                    headers: { ...sbHeaders, "Prefer": "return=minimal" },
                    body:    JSON.stringify({ appareils_iptv: appareilsIptv.join(",") }),
                }
            );
        } catch (_) {}

    } else {
        // ❌ Limite d'appareils atteinte
        // Retourner un M3U spécial avec un lien pour forcer la déconnexion
        const forceUrl = baseUrl + "/playlist?key=" + encodeURIComponent(userKey) + "&force=1";
        const m3uErr   =
            "#EXTM3U\n" +
            "#EXTINF:-1 tvg-name=\"⛔ LIMITE ATTEINTE\" group-title=\"Erreur\",⛔ Limite d'appareils atteinte (" + maxScreens + " max)\n" +
            forceUrl + "\n\n" +
            "#EXTINF:-1 tvg-name=\"🔓 DÉCONNECTER LES AUTRES\" group-title=\"Erreur\",🔓 Appuyez ici pour déconnecter les autres appareils\n" +
            forceUrl + "\n\n";

        return new Response(m3uErr, {
            status: 200,
            headers: {
                ...CORS,
                "Content-Type":  "application/x-mpegURL; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Error":       "max-devices",
            },
        });
    }

    // ── 4. Récupérer les chaînes depuis Supabase ──────────────
    let channels = [];
    try {
        const chRes = await fetch(
            SUPABASE_URL + "/rest/v1/channels_data?select=data&order=published_at.desc&limit=1",
            { headers: sbHeaders }
        );
        if (!chRes.ok) return errResponse("Erreur chargement chaînes. Réessayez.", 503, CORS);

        const rows = await chRes.json();
        if (rows && rows.length > 0 && Array.isArray(rows[0].data)) {
            rows[0].data.forEach((ch, i) => {
                if (!ch.url) return;
                channels.push({
                    index:    i,
                    name:     (ch.name     || "Chaine").trim(),
                    logo:      ch.logo     || "",
                    category:  ch.category || "Autres",
                });
            });
        }
    } catch (_) {
        return errResponse("Erreur serveur chaînes. Réessayez.", 503, CORS);
    }

    if (channels.length === 0) return errResponse("Aucune chaîne disponible.", 404, CORS);

    // ── 5. Filtres optionnels ─────────────────────────────────
    if (category) channels = channels.filter(c => (c.category || "").toLowerCase().includes(category));
    if (search)   channels = channels.filter(c => (c.name     || "").toLowerCase().includes(search));

    // ── 6. Format JSON ────────────────────────────────────────
    if (format === "json") {
        const safe = channels.map(c => ({ index: c.index, name: c.name, logo: c.logo, category: c.category }));
        return new Response(JSON.stringify(safe, null, 2), {
            status: 200,
            headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
    }

    // ── 7. Format M3U avec did intégré ────────────────────────
    let m3u =
        "#EXTM3U x-tvg-url=\"\" tvg-shift=0\n" +
        "# My Box Smart - " + channels.length + " chaines\n" +
        "# " + new Date().toISOString().split("T")[0] + "\n\n";

    for (const c of channels) {
        const name       = (c.name     || "Chaine").replace(/"/g, "'").replace(/,/g, " ").trim();
        const logo       = (c.logo     || "").trim();
        const cat        = (c.category || "Autres").replace(/"/g, "'").replace(/,/g, " ").trim();
        const num        = c.index + 1;
        const proxyUrl   = baseUrl + "/stream?key=" + encodeURIComponent(userKey) + "&ch=" + c.index + "&did=" + encodeURIComponent(deviceId);

        m3u += "#EXTINF:-1 tvg-id=\"" + num + "\" tvg-chno=\"" + num + "\" tvg-name=\"" + name + "\"";
        if (logo) m3u += " tvg-logo=\"" + logo + "\"";
        m3u += " group-title=\"" + cat + "\"," + name + "\n";
        m3u += proxyUrl + "\n\n";
    }

    return new Response(m3u, {
        status: 200,
        headers: {
            ...CORS,
            "Content-Type":        "application/x-mpegURL; charset=utf-8",
            "Content-Disposition": "attachment; filename=\"myboxsmart.m3u\"",
            "Cache-Control":       "no-store, no-cache",
            "X-Total-Channels":    String(channels.length),
            "X-Device-Id":         deviceId,
        },
    });
}
