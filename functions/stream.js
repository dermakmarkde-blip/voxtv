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
 *      (dans la colonne `appareils` OU `appareils_iptv`)
 *   3. Génère un token signé HMAC-SHA256 valable 4h
 *   4. Redirige vers /stream?tok=TOKEN&ch=42
 *
 * MODE TOKEN :
 *   /stream?tok=TOKEN&ch=42
 *   → Vérifie token → redirige vers vrai flux (table channels_data)
 *
 * ⚠️  SUPABASE_URL / SUPABASE_KEY doivent correspondre au projet
 *     utilisé par index_vox.html (jkcityzwqvlppwasqsru).
 * ⚠️  SECRET_KEY doit être identique dans stream.js ET playlist.js.
 * ============================================================
 */

// ─── Supabase — même projet que index_vox.html ────────────────
const SUPABASE_URL = "https://jkcityzwqvlppwasqsru.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprY2l0eXp3cXZscHB3YXNxc3J1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTg1NDIsImV4cCI6MjA5MDg5NDU0Mn0.N2cxY-9SOKGqDQV4eTGz_Tdxa9zg3e5gQ1t79SMsS-U";

// ─── Secret HMAC — doit être identique dans playlist.js ──────
const SECRET_KEY = "Maman Yasmine1@";

// ─── Durée de validité du token (4 heures) ───────────────────
const TOKEN_TTL = 4 * 60 * 60;

// ─── Headers Supabase ─────────────────────────────────────────
const sbHeaders = {
    "apikey":        SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type":  "application/json",
};

// ============================================================
// HELPERS
// ============================================================

/**
 * Calcule les jours restants d'un abonnement.
 * Retourne 9999 pour les abonnements "VIE".
 */
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

/** Réponse d'erreur texte avec CORS. */
function errResponse(msg, status) {
    return new Response(msg, {
        status: status || 403,
        headers: {
            "Content-Type":                "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

/** Signe un message avec HMAC-SHA256, retourne hex. */
async function hmacSign(message, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false, ["sign"]
    );
    const sig   = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const bytes = new Uint8Array(sig);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Crée un token signé encodé en base64 :
 *   base64(chIndex:expiry:userKey:deviceId) + "." + hmac_hex
 */
async function createToken(userKey, chIndex, deviceId) {
    const expiry  = Math.floor(Date.now() / 1000) + TOKEN_TTL;
    const payload = chIndex + ":" + expiry + ":" + userKey + ":" + deviceId;
    const sig     = await hmacSign(payload, SECRET_KEY);
    return btoa(payload) + "." + sig;
}

/**
 * Vérifie un token et retourne { chIndex, userKey, deviceId }
 * ou null si invalide / expiré.
 */
async function verifyToken(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 2) return null;

        const payload  = atob(parts[0]);
        const expected = await hmacSign(payload, SECRET_KEY);
        if (expected !== parts[1]) return null;   // signature invalide

        const segs = payload.split(":");
        if (segs.length < 4) return null;

        const chIndex  = parseInt(segs[0]);
        const expiry   = parseInt(segs[1]);
        const userKey  = segs[2];
        // deviceId peut contenir ":" (format rawId__NomAppareil) → rejoindre le reste
        const deviceId = segs.slice(3).join(":");

        if (Math.floor(Date.now() / 1000) > expiry) return null;  // expiré
        return { chIndex, userKey, deviceId };
    } catch (_) {
        return null;
    }
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================
export async function onRequest(context) {
    const request = context.request;
    const reqUrl  = new URL(request.url);
    const params  = reqUrl.searchParams;
    const baseUrl = reqUrl.origin;

    // ── Preflight CORS ─────────────────────────────────────────
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status:  204,
            headers: {
                "Access-Control-Allow-Origin":  "*",
                "Access-Control-Allow-Methods": "GET",
            },
        });
    }

    const userKey  = (params.get("key") || "").trim().toUpperCase();
    const tokStr   =  params.get("tok") || "";
    const chIndex  = parseInt(params.get("ch") || "-1");
    const deviceId = (params.get("did") || "").trim();

    // ══════════════════════════════════════════════════════════
    // MODE TOKEN — lecture directe via token signé (IPTV / M3U)
    // ══════════════════════════════════════════════════════════
    if (tokStr) {
        const decoded = await verifyToken(tokStr);

        if (!decoded) {
            return errResponse(
                "Lien expiré. Retéléchargez votre playlist sur myboxsmart.pages.dev",
                403
            );
        }

        // Token valide → récupérer le vrai lien depuis channels_data
        try {
            const chRes = await fetch(
                SUPABASE_URL + "/rest/v1/channels_data?select=data&order=published_at.desc&limit=1",
                { headers: sbHeaders }
            );
            if (!chRes.ok) return errResponse("Erreur serveur.", 503);

            const rows   = await chRes.json();
            const chData = rows?.[0]?.data?.[decoded.chIndex];
            if (!chData?.url) return errResponse("Chaîne introuvable.", 404);

            return new Response(null, {
                status:  302,
                headers: {
                    "Location":                    chData.url,
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control":               "no-store, no-cache",
                },
            });
        } catch (_) {
            return errResponse("Erreur serveur.", 503);
        }
    }

    // ══════════════════════════════════════════════════════════
    // MODE CLÉ + DEVICE ID — vérification complète
    // ══════════════════════════════════════════════════════════
    if (!userKey)                        return errResponse("Accès refusé - clé manquante", 403);
    if (!deviceId)                       return errResponse("Accès refusé - appareil non identifié", 403);
    if (isNaN(chIndex) || chIndex < 0)  return errResponse("Chaîne invalide", 400);

    // ── 1. Vérifier abonnement + présence du device dans Supabase ──
    try {
        const authRes = await fetch(
            SUPABASE_URL + "/rest/v1/utilisateurs?cle=eq." +
            encodeURIComponent(userKey) +
            "&select=cle,duree,date_activation,max_ecrans,appareils,appareils_iptv&limit=1",
            { headers: sbHeaders }
        );

        if (!authRes.ok) return errResponse("Erreur serveur. Réessayez.", 503);

        const users = await authRes.json();
        if (!users || users.length === 0) {
            return errResponse("Accès refusé - clé invalide", 403);
        }

        const user     = users[0];
        const daysLeft = calcDaysLeft(user);

        if (daysLeft <= 0 && user.duree !== "VIE") {
            return errResponse("Accès refusé - abonnement expiré", 403);
        }

        // Construire la liste complète des appareils autorisés
        // • appareils      → appareils web (format "rawId__NomAppareil")
        // • appareils_iptv → appareils IPTV (clé brute ou rawId)
        const apSite = (user.appareils      || "").split(",").map(d => d.trim()).filter(Boolean);
        const apIptv = (user.appareils_iptv || "").split(",").map(d => d.trim()).filter(Boolean);
        // Union sans doublon
        const allAp  = [...new Set([...apSite, ...apIptv])];

        // Recherche exacte OU correspondance sur la partie rawId (avant "__")
        const rawDid   = deviceId.split("__")[0];
        const allowed  = allAp.some(d => d === deviceId || d.split("__")[0] === rawDid);

        if (!allowed) {
            return errResponse(
                "Appareil non autorisé. Retéléchargez votre playlist sur myboxsmart.pages.dev",
                403
            );
        }

    } catch (_) {
        return errResponse("Erreur serveur temporaire.", 503);
    }

    // ── 2. Générer le token signé (valable 4h) et rediriger ────
    try {
        const token    = await createToken(userKey, chIndex, deviceId);
        const tokenUrl = baseUrl + "/stream?tok=" + encodeURIComponent(token) + "&ch=" + chIndex;

        return new Response(null, {
            status:  302,
            headers: {
                "Location":                    tokenUrl,
                "Access-Control-Allow-Origin": "*",
                "Cache-Control":               "no-store, no-cache",
            },
        });
    } catch (_) {
        return errResponse("Erreur génération token.", 503);
    }
}
