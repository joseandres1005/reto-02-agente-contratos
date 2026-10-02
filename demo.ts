// demo.ts
// Script determinista: procesa los 6 mensajes del buzón llamando directamente
// a las herramientas, sin consumir un modelo de lenguaje.

import { readFile, rm, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  leer_buzon,
  extraer,
  validar,
  registrar,
  alertas,
  type ToolContext,
} from "./src/tools/contratos.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = __dirname;
const OUT = join(ROOT, "out");
const FIXTURES = join(ROOT, "fixtures/reto-02");

const ctx: ToolContext = {
  directory: ROOT,
  sessionId: "demo-determinista",
  outDir: OUT,
};

// ============================================================================
// PRESENTACIÓN
// ============================================================================
const HR = "─".repeat(72);
const HR2 = "═".repeat(72);

function titulo(texto: string) {
  console.log(`\n${HR2}\n${texto}\n${HR2}`);
}

function seccion(texto: string) {
  console.log(`\n${HR}\n${texto}\n${HR}`);
}

function safeJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { ok: false, error: "JSON inválido" };
  }
}

// ============================================================================
// PREPARACIÓN
// ============================================================================
async function preparar() {
  titulo("DEMO — Procesamiento determinista del buzón (sin LLM)");
  console.log("Reto 02 · Periferia IT Group · Agente de Registro de Contratos\n");

  if (existsSync(OUT)) {
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(join(OUT, "sharepoint"), { recursive: true });

  await cp(
    join(FIXTURES, "maestro-contratos.csv"),
    join(OUT, "sharepoint/maestro-contratos.csv")
  );
  console.log("📦 Fixture copiado a out/sharepoint/maestro-contratos.csv");
  console.log("📂 out/ limpiado");
}

// ============================================================================
// PRIMERA PASADA
// ============================================================================
async function primeraPasada() {
  seccion("PRIMERA PASADA — Procesando buzón");

  const buzon = safeJSON(await leer_buzon.execute({}, ctx));
  if (!buzon.ok) {
    console.error("❌ Error leyendo buzón:", buzon.error);
    return [];
  }

  console.log(`📨 Mensajes pendientes: ${buzon.data.mensajes.length}\n`);

  const resultados: any[] = [];

  for (const msg of buzon.data.mensajes) {
    console.log(`\n${"─".repeat(72)}`);
    console.log(`📨 ${msg.id} — ${msg.asunto}`);
    console.log(`   De: ${msg.de}`);
    console.log(`   Adjuntos: ${msg.adjuntos.join(", ")}`);

    const tieneContrato = msg.tiene_contrato;
    console.log(
      `\n   🔍 Clasificación: ${tieneContrato ? "CONTRATO/OTROSÍ" : "SIN CONTRATO"}`
    );

    // 1. Validar (recalcula internamente)
    const val = safeJSON(await validar.execute({ mensaje_id: msg.id }, ctx));
    if (!val.ok) {
      console.log(`   ❌ Error validación: ${val.error}`);
      continue;
    }
    const v = val.data;

    // Si es sin contrato, solo validar y registrar (que omitirá)
    if (!tieneContrato) {
      console.log(`   ⛔ ${v.motivo}`);
      const reg = safeJSON(
        await registrar.execute({ mensaje_id: msg.id, confirmado: false }, ctx)
      );
      console.log(`   📦 Acción: ${reg.data?.accion ?? "omitido"}`);
      resultados.push({
        msg: msg.id,
        clasif: v.clasificacion,
        accion: reg.data?.accion ?? "omitido",
        revision: [],
      });
      continue;
    }

    // 2. Extraer solo para mostrar los campos en el log
    const ex = safeJSON(await extraer.execute({ mensaje_id: msg.id }, ctx));
    if (!ex.ok) {
      console.log(`   ❌ Error extracción: ${ex.error}`);
      continue;
    }
    const contrato = ex.data.contrato;

    console.log(
      `\n   📄 Extracción (confianza global: ${contrato.confidence_global.toFixed(2)}):`
    );
    console.log(
      `      id_contrato:  ${contrato.id_contrato.valor} (${contrato.id_contrato.confidence.toFixed(2)})`
    );
    console.log(
      `      cliente:      ${contrato.cliente.valor} (${contrato.cliente.confidence.toFixed(2)})`
    );
    console.log(
      `      nit_cliente:  ${contrato.nit_cliente.valor} (${contrato.nit_cliente.confidence.toFixed(2)})`
    );
    console.log(
      `      valor:        ${contrato.valor.valor} (${contrato.valor.confidence.toFixed(2)})`
    );
    console.log(
      `      fecha_inicio: ${contrato.fecha_inicio.valor} (${contrato.fecha_inicio.confidence.toFixed(2)})`
    );
    console.log(
      `      fecha_fin:    ${contrato.fecha_fin.valor} (${contrato.fecha_fin.confidence.toFixed(2)})`
    );
    console.log(
      `      póliza:       ${contrato.requiere_poliza.valor} / ${contrato.tipo_poliza.valor ?? "-"}`
    );

    // 3. Mostrar validación
    console.log(`\n   ✅ Validación: ${v.clasificacion.toUpperCase()}`);
    console.log(
      `      comercial: ${v.comercial}${v.region ? ` (${v.region})` : ""}`
    );
    if (v.id_contrato_existente)
      console.log(`      contrato existente: ${v.id_contrato_existente}`);
    if (v.requiere_revision.length > 0) {
      console.log(
        `      ⚠️  requiere revisión: [${v.requiere_revision.join(", ")}]`
      );
    } else {
      console.log(`      requiere revisión: ninguno`);
    }
    if (Object.keys(v.diferencias).length > 0) {
      console.log(`      diferencias: ${JSON.stringify(v.diferencias)}`);
    }

    // 4. Registrar (recalcula internamente)
    const reg = safeJSON(
      await registrar.execute({ mensaje_id: msg.id, confirmado: false }, ctx)
    );

    if (reg.ok && reg.data?.accion && reg.data.accion !== "rechazado") {
      console.log(
        `   💾 Registro: ${reg.data.accion} → ${reg.data.id_contrato ?? "—"}`
      );
      resultados.push({
        msg: msg.id,
        clasif: v.clasificacion,
        accion: reg.data.accion,
        revision: v.requiere_revision,
      });
    } else {
      console.log(`   🛑 Registro bloqueado: ${reg.error ?? reg.data?.error}`);
      console.log(`   ⏸️  Turno terminado con pregunta al usuario:`);
      console.log(`      "Confirmas registrar con los siguientes ajustes:"`);
      console.log(`         - valor: 0`);
      console.log(`         - fecha_fin: 2027-08-31`);
      resultados.push({
        msg: msg.id,
        clasif: v.clasificacion,
        accion: "pendiente_confirmacion",
        revision: v.requiere_revision,
      });
    }
  }

  return resultados;
}

// ============================================================================
// SEGUNDA PASADA — confirmación de msg-006
// ============================================================================
async function segundaPasada() {
  seccion("SEGUNDA PASADA — Confirmación humana de msg-006");
  console.log(`👤 Usuario: "Confirmo el valor 0 y la fecha fin 2027-08-31"\n`);

  // En el diseño nuevo, la confirmación es simplemente pasar confirmado: true.
  // El extractor determinista + herencia de campos se encargan del resto.
  const reg = safeJSON(
    await registrar.execute({ mensaje_id: "msg-006", confirmado: true }, ctx)
  );

  if (reg.ok) {
    console.log(
      `\n   💾 Registro confirmado: ${reg.data.accion} → ${reg.data.id_contrato}`
    );
    console.log(`   📁 Archivado en: ${reg.data.ruta_archivo}`);
  } else {
    console.log(`   ❌ Error: ${reg.error}`);
  }
}

// ============================================================================
// ALERTAS
// ============================================================================
async function reporteAlertas() {
  seccion("REPORTE DE ALERTAS (hoy = 2026-09-03)");
  const r = safeJSON(await alertas.execute({ hoy: "2026-09-03" }, ctx));
  if (!r.ok) {
    console.error("❌ Error:", r.error);
    return;
  }

  console.log(`📄 Generado: ${r.data.ruta}\n`);
  console.log(`⏰ Vencen en ≤ 60 días: ${r.data.vencen.length}`);
  for (const v of r.data.vencen) {
    console.log(
      `   - ${v.id_contrato} | ${v.cliente} | vence ${v.fecha_fin} (${v.dias_restantes}d) | ${v.comercial}`
    );
  }
  console.log(
    `\n📋 Pólizas pendientes/no vigentes: ${r.data.polizas_pendientes.length}`
  );
  for (const p of r.data.polizas_pendientes) {
    console.log(
      `   - ${p.id_contrato} | ${p.cliente} | ${p.tipo_poliza} | ${p.estado_poliza}`
    );
  }
  console.log(
    `\n📥 Registrados desde corte 2026-05-30: ${r.data.registrados_desde_corte.length}`
  );
  for (const g of r.data.registrados_desde_corte) {
    console.log(`   - ${g.id_contrato} | ${g.fecha_registro}`);
  }
}

// ============================================================================
// RESUMEN
// ============================================================================
function resumenFinal(resultados: any[]) {
  seccion("RESUMEN FINAL");
  console.log(`📊 Total mensajes procesados: ${resultados.length}\n`);
  console.log("| msg | clasificación | acción | requiere revisión |");
  console.log("|---|---|---|---|");
  for (const r of resultados) {
    const rev = r.revision.length > 0 ? r.revision.join(", ") : "—";
    console.log(`| ${r.msg} | ${r.clasif} | ${r.accion} | ${rev} |`);
  }

  console.log(`\n📁 Archivos generados:`);
  console.log(`   - out/sharepoint/maestro-contratos.csv`);
  console.log(`   - out/sharepoint/historial.jsonl`);
  console.log(`   - out/sharepoint/Contratos/...`);
  console.log(`   - out/procesados.json`);
  console.log(`   - out/log.jsonl`);
  console.log(`   - out/alertas.md`);
  console.log(`\n✅ Demo completada — resultado determinista y reproducible.\n`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  await preparar();
  const resultados = await primeraPasada();
  await segundaPasada();
  await reporteAlertas();
  if (resultados) resumenFinal(resultados);
}

main().catch((e) => {
  console.error("❌ Error fatal:", e);
  process.exit(1);
});
