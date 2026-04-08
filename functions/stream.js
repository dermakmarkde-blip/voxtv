/**
 * ============================================================
 * MY BOX SMART — PROXY DE FLUX + VÉRIFICATION DEVICE ID
 * Cloudflare Pages Function : /functions/stream.js
 *
 * Le client appelle :
 *   /stream?key=CLE&ch=42&did=DEVICE_ID
 *
 * Ce fichier :
 *   1. Vérifie que la clé est valide et non expirée
 *   2. Vérifie que le device_id est bien enregistré pour cette clé
 *   3. Génère un token signé valable 4h
 *   4. Redirige vers /stream?tok=TOKEN&ch=42
 *
 * MODE TOKEN :
 *   /stream?tok=TOKEN&ch=42
 *   → Vérifie token → redirige vers vrai flux
 * ============================================================
 */

const SUPABASE_URL = "https://yvcdadenofftnbljutwk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2Y2RhZGVub2ZmdG5ibGp1dHdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4NzQ0ODIsImV4cCI6MjA4ODQ1MDQ4Mn0.xqJzLpQszFmph599FBIvdE7NF88_i-JkABG-aSrAndE";

// ⚠️ DOIT ÊTRE IDENTIQUE À CELUI DANS stream.js
const SECRET_KEY = "Maman Yasmine1@";

// Durée de validité du token (4 heures)
const TOKEN_TTL = 4 * 60 * 60;

var sbHeaders = {
    "apikey":        SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type":  "application/json",
};

function calcDaysLeft(user) {
    if (!user) return 0;
    if (user.duree === "VIE") return 9999;
    var total = parseInt(user.duree) || 0;
    if (total <= 0) return 0;
    if (!user.date_activation) return total;
    var act   = new Date(user.date_activation);
    var today = new Date();
    act.setHours(0,0,0,0);
    today.setHours(0,0,0,0);
    return Math.max(0, total - Math.floor((today - act) / 86400000));
}

function errResponse(msg, status) {
    return new Response(msg, {
        status: status || 403,
        headers: {
            "Content-Type":                "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        }
    });
}

async function hmacSign(message, secret) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false, ["sign"]
    );
    var sig   = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    var bytes = new Uint8Array(sig);
    return Array.from(bytes).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function createToken(userKey, chIndex, deviceId) {
    var expiry  = Math.floor(Date.now() / 1000) + TOKEN_TTL;
    var payload = chIndex + ":" + expiry + ":" + userKey + ":" + deviceId;
    var sig     = await hmacSign(payload, SECRET_KEY);
    return btoa(payload) + "." + sig;
}

async function verifyToken(token) {
    try {
        var parts = token.split(".");
        if (parts.length !== 2) return null;
        var payload  = atob(parts[0]);
        var expected = await hmacSign(payload, SECRET_KEY);
        if (expected !== parts[1]) return null;
        var segs    = payload.split(":");
        if (segs.length < 4) return null;
        var chIndex  = parseInt(segs[0]);
        var expiry   = parseInt(segs[1]);
        var userKey  = segs[2];
        var deviceId = segs[3];
        if (Math.floor(Date.now() / 1000) > expiry) return null;
        return { chIndex, userKey, deviceId };
    } catch(e) {
        return null;
    }
}

export async function onRequest(context) {
    var request = context.request;
    var reqUrl  = new URL(request.url);
    var params  = reqUrl.searchParams;
    var baseUrl = reqUrl.origin;

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" }
        });
    }

    var userKey  = (params.get("key") || "").trim().toUpperCase();
    var tokStr   = params.get("tok")  || "";
    var chIndex  = parseInt(params.get("ch") || "-1");
    var deviceId = (params.get("did") || "").trim();

    // ══════════════════════════════════════════════════════════
    // MODE TOKEN — lecture directe via token signé
    // ══════════════════════════════════════════════════════════
    if (tokStr) {
        var decoded = await verifyToken(tokStr);

        if (!decoded) {
            return errResponse(
                "Lien expiré. Retéléchargez votre playlist sur myboxsmart.pages.dev", 403
            );
        }

        // Token valide → récupérer le vrai lien
        try {
            var chRes = await fetch(
                SUPABASE_URL + "/rest/v1/channels_data?select=data&order=published_at.desc&limit=1",
                { headers: sbHeaders }
            );
            if (!chRes.ok) return errResponse("Erreur serveur.", 503);

            var rows   = await chRes.json();
            var chData = rows?.[0]?.data?.[decoded.chIndex];
            if (!chData?.url) return errResponse("Chaîne introuvable.", 404);

            return new Response(null, {
                status: 302,
                headers: {
                    "Location":                    chData.url,
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control":               "no-store, no-cache",
                }
            });
        } catch(e) {
            return errResponse("Erreur serveur.", 503);
        }
    }

    // ══════════════════════════════════════════════════════════
    // MODE CLÉ + DEVICE ID — vérification complète
    // ══════════════════════════════════════════════════════════
    if (!userKey)  return errResponse("Accès refusé - clé manquante", 403);
    if (!deviceId) return errResponse("Accès refusé - appareil non identifié", 403);
    if (isNaN(chIndex) || chIndex < 0) return errResponse("Chaîne invalide", 400);

    // ── 1. Vérifier abonnement + device_id dans Supabase ─────
    try {
        var authRes = await fetch(
            SUPABASE_URL + "/rest/v1/utilisateurs?cle=eq." +
            encodeURIComponent(userKey) +
            "&select=cle,duree,date_activation,max_ecrans,appareils,appareils_iptv&limit=1",
            { headers: sbHeaders }
        );

        if (!authRes.ok) return errResponse("Erreur serveur. Réessayez.", 503);

        var users = await authRes.json();
        if (!users || users.length === 0) {
            return errResponse("Accès refusé - clé invalide", 403);
        }

        var user     = users[0];
        var daysLeft = calcDaysLeft(user);
        if (daysLeft <= 0 && user.duree !== "VIE") {
            return errResponse("Accès refusé - abonnement expiré", 403);
        }

        // Vérifier que ce device_id est enregistré (site OU IPTV)
        var apSite = (user.appareils      || "").split(",").map(function(d){ return d.trim(); }).filter(Boolean);
        var apIptv = (user.appareils_iptv || "").split(",").map(function(d){ return d.trim(); }).filter(Boolean);
        var allAp  = apSite.concat(apIptv.filter(function(d){ return apSite.indexOf(d)===-1; }));

        if (allAp.indexOf(deviceId) === -1) {
            return errResponse(
                "Appareil non autorisé. Retéléchargez votre playlist sur myboxsmart.pages.dev",
                403
            );
        }

    } catch(e) {
        return errResponse("Erreur serveur temporaire.", 503);
    }

    // ── 2. Générer token signé (valable 4h) et rediriger ─────
    try {
        var token    = await createToken(userKey, chIndex, deviceId);
        var tokenUrl = baseUrl + "/stream?tok=" + encodeURIComponent(token) + "&ch=" + chIndex;

        return new Response(null, {
            status: 302,
            headers: {
                "Location":                    tokenUrl,
                "Access-Control-Allow-Origin": "*",
                "Cache-Control":               "no-store, no-cache",
            }
        });
    } catch(e) {
        return errResponse("Erreur génération token.", 503);
    }
}
