import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-access-code",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BUCKET = "solicitudes";
const MAX = 20 * 1024 * 1024;

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function autorizado(pwd: string | null) {
  if (!pwd) return false;
  const envCode = Deno.env.get("ACCESS_CODE");
  if (envCode && pwd === envCode) return true;
  const { data } = await supabase.from("genesis_config").select("valor").eq("clave", "password_sha256").maybeSingle();
  return !!data?.valor && (await sha256(pwd)) === data.valor;
}

const PROMPT = `Eres un asistente de reclutamiento. Lee la solicitud de empleo adjunta (PDF) y genera un resumen GUÍA para quien contrata. Tú NO decides ni recomiendas contratar o rechazar.

Reglas de equidad (obligatorias):
- Puedes transcribir lo que dice cada recuadro, pero NO uses para evaluar: edad, fecha de nacimiento, sexo/género, estado civil, hijos, embarazo, religión, origen étnico o nacional, nacionalidad, salud o discapacidad, apariencia/foto, orientación sexual, afiliación política o sindical.
- La "forma de escritura" se evalúa solo por claridad, orden y completitud de lo escrito; menciona ortografía solo si el puesto requiere redacción. No hagas inferencias de personalidad.
- Si algo es ilegible o no viene, dilo; no inventes.

Responde SOLO con un objeto JSON válido (sin texto extra, sin \`\`\`), en español, con esta forma:
{
  "nombre": string|null,
  "puesto_solicitado": string|null,
  "resumen": string (3-5 frases),
  "recuadros": [{"campo": string, "contenido": string}],
  "experiencia": [{"empresa": string|null, "puesto": string|null, "periodo": string|null, "funciones": string|null}],
  "escolaridad": string|null,
  "habilidades": [string],
  "escritura": {"claridad": "alta"|"media"|"baja", "completitud": "alta"|"media"|"baja", "observaciones": string},
  "campos_vacios": [string],
  "inconsistencias": [string],
  "fortalezas": [string],
  "puntos_a_verificar": [string],
  "preguntas_entrevista": [string]
}`;

async function analizar(b64: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Falta el secreto ANTHROPIC_API_KEY en Supabase");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(130_000),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`API de Claude ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text: string = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("La respuesta no trajo JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const str = (v: unknown, max = 200) => (v == null || v === "" ? null : String(v).trim().slice(0, max));
const fecha = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ===== Horas / nómina (mismo cálculo que usa el checador) =====
const DIAS_ORDEN = ["vie", "sab", "dom", "lun", "mar", "mie", "jue"];
function timeToMin(t: unknown): number | null {
  if (!t || typeof t !== "string") return null;
  const p = t.split(":");
  const v = parseInt(p[0], 10) * 60 + parseInt(p[1] || "0", 10);
  return isNaN(v) ? null : v;
}
function scheduleHoursOf(sch: any): number {
  if (!sch) return 0;
  let total = 0;
  for (const k of DIAS_ORDEN) {
    const day = sch[k];
    if (day && day.on) {
      const a = timeToMin(day.start), b = timeToMin(day.end);
      if (a != null && b != null && b > a) total += (b - a) / 60;
    }
  }
  return total;
}

// El checador calcula "día" y "semana de pago" con la hora LOCAL del navegador de quien
// checa (México). Este servidor corre con reloj UTC, así que un turno que cruza medianoche
// UTC (p.ej. entrada 11:47am y salida 8:06pm hora de México, que en UTC caen en dos fechas
// distintas) se partía en dos registros en vez de uno solo. Para que Genesis calcule
// exactamente lo mismo que el checador, todo el cálculo de "día" usa la hora de Ciudad de
// México (sin horario de verano desde 2022).
const TZ = "America/Mexico_City";
const LOCAL_DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const LOCAL_WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localDateParts(d: Date): { y: number; m: number; day: number } {
  const parts = LOCAL_DATE_FMT.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}
function tzOffsetMinutes(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUTC - d.getTime()) / 60000; // minutos que hay que sumarle a UTC para obtener la hora local
}
// Instante UTC que corresponde a la medianoche local (TZ) de un año/mes/día dados.
function localMidnightUTC(y: number, m: number, day: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, day, 0, 0, 0));
  const offsetMin = tzOffsetMinutes(guess);
  return new Date(guess.getTime() - offsetMin * 60000);
}
function dayKey(iso: string): string {
  const { y, m, day } = localDateParts(new Date(iso));
  return `${y}-${m}-${day}`;
}
function payWeekStart(iso: string): Date {
  const d = new Date(iso);
  const { y, m, day } = localDateParts(d);
  const midnight = localMidnightUTC(y, m, day);
  const dow = WEEKDAY_NUM[LOCAL_WEEKDAY_FMT.format(d)];
  const diff = (dow - 5 + 7) % 7;
  return new Date(midnight.getTime() - diff * 86400000);
}
function payWeekKeyOf(d: Date): string {
  const { y, m, day } = localDateParts(d);
  return `${y}-${m}-${day}`;
}
function payWeekKey(iso: string): string {
  return payWeekKeyOf(payWeekStart(iso));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  if (!(await autorizado(req.headers.get("x-access-code")))) return json({ error: "Contraseña incorrecta" }, 401);

  const body = await req.json().catch(() => ({}));
  console.log("[accion]", body.accion);

  switch (body.accion) {
    case "verificar":
      return json({ ok: true });

    // ===== Tiendas =====
    case "tiendas_listar": {
      const { data, error } = await supabase.from("tiendas").select("id, nombre, ubicacion, responsable").order("nombre");
      if (error) return json({ error: error.message }, 500);
      return json({ tiendas: data });
    }
    case "tiendas_guardar": {
      const t = body.tienda || {};
      const row = { nombre: str(t.nombre, 100), ubicacion: str(t.ubicacion, 200), responsable: str(t.responsable, 120) };
      if (!row.nombre) return json({ error: "El nombre de la tienda es obligatorio" }, 400);
      const q = t.id
        ? supabase.from("tiendas").update(row).eq("id", t.id).select().single()
        : supabase.from("tiendas").insert(row).select().single();
      const { data, error } = await q;
      if (error) return json({ error: error.code === "23505" ? "Ya existe una tienda con ese nombre" : error.message }, 400);
      return json({ tienda: data });
    }
    case "tiendas_eliminar": {
      if (!body.id) return json({ error: "Falta id" }, 400);
      const { error } = await supabase.from("tiendas").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ===== Candidatos =====
    case "listar": {
      const { data, error } = await supabase.from("candidatos")
        .select("id, created_at, archivo_nombre, nombre, puesto_solicitado, resumen, analisis, estado, error")
        .order("created_at", { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ candidatos: data });
    }
    case "preparar": {
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.pdf`;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) return json({ error: `Storage: ${error.message}` }, 500);
      return json({ path, signedUrl: data.signedUrl });
    }
    case "analizar": {
      const path = String(body.path || "");
      if (!/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.pdf$/.test(path)) return json({ error: "Ruta inválida" }, 400);
      const nombreArchivo = String(body.nombre || "solicitud.pdf").slice(0, 200);
      const dl = await supabase.storage.from(BUCKET).download(path);
      if (dl.error || !dl.data) return json({ error: `No se encontró el PDF: ${dl.error?.message ?? ""}` }, 404);
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      if (bytes.length > MAX) return json({ error: "El PDF supera 20 MB" }, 400);
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        await supabase.storage.from(BUCKET).remove([path]);
        return json({ error: "El archivo no es un PDF válido" }, 400);
      }
      const ins = await supabase.from("candidatos").insert({ archivo_path: path, archivo_nombre: nombreArchivo }).select("id").single();
      if (ins.error) return json({ error: ins.error.message }, 500);
      const id = ins.data.id;
      try {
        const a = await analizar(encodeBase64(bytes));
        await supabase.from("candidatos").update({
          nombre: a.nombre ?? null, puesto_solicitado: a.puesto_solicitado ?? null,
          resumen: a.resumen ?? null, analisis: a, estado: "analizado",
        }).eq("id", id);
        return json({ id, analisis: a });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("candidatos").update({ estado: "error", error: msg }).eq("id", id);
        return json({ id, error: msg }, 502);
      }
    }

    // ===== Empleados =====
    case "empleados_listar": {
      const { data, error } = await supabase.from("empleados")
        .select("id, nombre, departamento, puesto, telefono, correo, fecha_nacimiento, fecha_ingreso, activo, worker_id, tienda_id").order("nombre");
      if (error) return json({ error: error.message }, 500);
      return json({ empleados: data });
    }
    case "empleados_guardar": {
      const e = body.empleado || {};
      const row = {
        nombre: str(e.nombre, 150), departamento: str(e.departamento, 80), puesto: str(e.puesto, 80),
        telefono: str(e.telefono, 40), correo: str(e.correo, 150),
        fecha_nacimiento: fecha(e.fecha_nacimiento), fecha_ingreso: fecha(e.fecha_ingreso), activo: e.activo !== false,
        worker_id: e.worker_id ? String(e.worker_id) : null,
        tienda_id: e.tienda_id ? String(e.tienda_id) : null,
      };
      if (!row.nombre) return json({ error: "El nombre es obligatorio" }, 400);
      const q = e.id
        ? supabase.from("empleados").update(row).eq("id", e.id).select().single()
        : supabase.from("empleados").insert(row).select().single();
      const { data, error } = await q;
      if (error) {
        if (error.code === "23505") return json({ error: "Ese trabajador del checador ya está vinculado a otro empleado" }, 400);
        return json({ error: error.message }, 500);
      }
      return json({ empleado: data });
    }
    case "empleados_eliminar": {
      if (!body.id) return json({ error: "Falta id" }, 400);
      const { error } = await supabase.from("empleados").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "cumpleanos": {
      const { data, error } = await supabase.from("empleados")
        .select("nombre, departamento, fecha_nacimiento, fecha_ingreso")
        .eq("activo", true).not("fecha_nacimiento", "is", null);
      if (error) return json({ error: error.message }, 500);
      return json({ cumpleanos: (data ?? []).map((r: any) => ({
        nombre: r.nombre, departamento: r.departamento,
        mes: Number(r.fecha_nacimiento.slice(5, 7)), dia: Number(r.fecha_nacimiento.slice(8, 10)),
        ingreso_anio: r.fecha_ingreso ? Number(r.fecha_ingreso.slice(0, 4)) : null,
      })) });
    }

    // ===== Checador (horas y nómina) =====
    case "checador_workers_listar": {
      const { data, error } = await supabase.from("workers").select("id, name, active").order("name");
      if (error) return json({ error: error.message }, 500);
      return json({ workers: data });
    }
    case "personal_resumen": {
      const [emp, wkr, tds] = await Promise.all([
        supabase.from("empleados")
          .select("id, nombre, departamento, puesto, telefono, correo, fecha_ingreso, activo, worker_id, tienda_id").order("nombre"),
        supabase.from("workers").select("id, salario, schedule"),
        supabase.from("tiendas").select("id, nombre"),
      ]);
      if (emp.error) return json({ error: emp.error.message }, 500);
      if (wkr.error) return json({ error: wkr.error.message }, 500);
      if (tds.error) return json({ error: tds.error.message }, 500);
      const empleados = emp.data ?? [];
      const workerById = new Map<string, any>((wkr.data ?? []).map((w: any): [string, any] => [w.id, w]));
      const tiendaById = new Map<string, any>((tds.data ?? []).map((t: any): [string, any] => [t.id, t]));

      const nowIso = new Date().toISOString();
      const weekStart = payWeekStart(nowIso);
      const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
      const workerIds = empleados.map((e: any) => e.worker_id).filter(Boolean);

      let records: any[] = [];
      if (workerIds.length) {
        const { data, error } = await supabase.from("records").select("worker_id, type, ts")
          .in("worker_id", workerIds).gte("ts", weekStart.toISOString()).lt("ts", weekEnd.toISOString());
        if (error) return json({ error: error.message }, 500);
        records = data ?? [];
      }
      const byWorker: Record<string, any[]> = {};
      records.forEach((r: any) => { (byWorker[r.worker_id] ??= []).push(r); });

      const personal = empleados.map((e: any) => {
        const w = e.worker_id ? workerById.get(e.worker_id) : null;
        const t = e.tienda_id ? tiendaById.get(e.tienda_id) : null;
        let horas: number | null = null, nomina: number | null = null, horasProg: number | null = null, enCurso = false;
        if (w) {
          horasProg = scheduleHoursOf(w.schedule);
          const list = (byWorker[w.id] || []).slice().sort((a: any, b: any) => +new Date(a.ts) - +new Date(b.ts));
          let open: any = null, total = 0;
          for (const r of list) {
            if (r.type === "entrada") open = r;
            else { if (open && dayKey(open.ts) === dayKey(r.ts)) total += (+new Date(r.ts) - +new Date(open.ts)) / 3600000; open = null; }
          }
          if (open) enCurso = true;
          horas = total;
          nomina = (w.salario && horasProg > 0) ? (total / horasProg) * w.salario : null;
        }
        return {
          id: e.id, nombre: e.nombre, departamento: e.departamento, puesto: e.puesto,
          telefono: e.telefono, correo: e.correo, fecha_ingreso: e.fecha_ingreso, activo: e.activo,
          worker_id: e.worker_id, vinculado: !!w,
          tienda_id: e.tienda_id, tienda_nombre: t ? t.nombre : null,
          horas, horas_programadas: horasProg, nomina, en_curso: enCurso,
        };
      });
      return json({ semana: { inicio: payWeekKeyOf(weekStart), fin: payWeekKeyOf(new Date(weekEnd.getTime() - 86400000)) }, personal });
    }
    case "historial_listar": {
      const workerId = body.worker_id ? String(body.worker_id) : null;
      const desde = typeof body.desde === "string" ? body.desde : null;
      const hasta = typeof body.hasta === "string" ? body.hasta : null;

      let q = supabase.from("records").select("worker_id, worker_name, type, ts");
      if (workerId) q = q.eq("worker_id", workerId);
      if (desde) q = q.gte("ts", `${desde}T00:00:00`);
      if (hasta) q = q.lte("ts", `${hasta}T23:59:59`);
      const { data: records, error } = await q;
      if (error) return json({ error: error.message }, 500);

      const { data: workers, error: wErr } = await supabase.from("workers").select("id, salario, schedule");
      if (wErr) return json({ error: wErr.message }, 500);
      const workerById = new Map<string, any>((workers ?? []).map((w: any): [string, any] => [w.id, w]));

      const byWorker: Record<string, any[]> = {};
      (records ?? []).forEach((r: any) => { (byWorker[r.worker_id] ??= []).push(r); });

      const sesiones: any[] = [];
      for (const wid of Object.keys(byWorker)) {
        const w = workerById.get(wid);
        const horasProg = w ? scheduleHoursOf(w.schedule) : 0;
        let open: any = null;
        const cumByWeek: Record<string, number> = {};
        const list = byWorker[wid].slice().sort((a: any, b: any) => +new Date(a.ts) - +new Date(b.ts));
        for (const r of list) {
          if (r.type === "entrada") {
            if (open) sesiones.push({ worker_id: wid, worker_name: open.worker_name, fecha: open.ts, entrada: open.ts, salida: null, horas: null, estado: "abierta", nomina: null });
            open = r;
          } else {
            if (open && dayKey(open.ts) === dayKey(r.ts)) {
              const h = (+new Date(r.ts) - +new Date(open.ts)) / 3600000;
              const wk = payWeekKey(open.ts);
              cumByWeek[wk] = (cumByWeek[wk] || 0) + h;
              const nomina = (w && w.salario && horasProg > 0) ? (cumByWeek[wk] / horasProg) * w.salario : null;
              sesiones.push({ worker_id: wid, worker_name: r.worker_name, fecha: open.ts, entrada: open.ts, salida: r.ts, horas: h, estado: "completa", nomina });
              open = null;
            } else {
              sesiones.push({ worker_id: wid, worker_name: r.worker_name, fecha: r.ts, entrada: null, salida: r.ts, horas: null, estado: "incompleta", nomina: null });
            }
          }
        }
        if (open) sesiones.push({ worker_id: wid, worker_name: open.worker_name, fecha: open.ts, entrada: open.ts, salida: null, horas: null, estado: "abierta", nomina: null });
      }
      sesiones.sort((a, b) => +new Date(b.fecha) - +new Date(a.fecha));
      return json({ sesiones });
    }
  }

  return json({ error: "Acción desconocida" }, 400);
});
