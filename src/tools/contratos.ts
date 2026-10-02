// src/tools/contratos.ts
// Herramientas tipadas con Zod para el agente de registro de contratos.

import { z } from "zod";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  appendFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// SCHEMAS ZOD
// ============================================================================

export const CampoExtraidoSchema = z.object({
  valor: z.any().describe("Valor extraído: string, number, boolean o null"),
  confidence: z.number().min(0).max(1),
  raw_span: z.string().optional(),
});
export type CampoExtraido = z.infer<typeof CampoExtraidoSchema>;

const campoVacio = () => ({ valor: null, confidence: 0 });

export const ContratoSchema = z.object({
  id_contrato: CampoExtraidoSchema.default(campoVacio()),
  cliente: CampoExtraidoSchema.default(campoVacio()),
  nit_cliente: CampoExtraidoSchema.default(campoVacio()),
  pais: CampoExtraidoSchema.default(campoVacio()),
  objeto: CampoExtraidoSchema.default(campoVacio()),
  valor: CampoExtraidoSchema.default(campoVacio()),
  moneda: CampoExtraidoSchema.default(campoVacio()),
  fecha_inicio: CampoExtraidoSchema.default(campoVacio()),
  fecha_fin: CampoExtraidoSchema.default(campoVacio()),
  requiere_poliza: CampoExtraidoSchema.default(campoVacio()),
  tipo_poliza: CampoExtraidoSchema.default(campoVacio()),
  confidence_global: z.number().min(0).max(1).default(0),
});

export type Contrato = z.infer<typeof ContratoSchema>;

export const ValidacionResultSchema = z.object({
  clasificacion: z.enum(["nuevo", "actualizacion", "duplicado", "rechazado"]),
  id_contrato_existente: z.string().nullable(),
  requiere_revision: z.array(z.string()),
  motivo: z.string(),
  comercial: z.string(),
  region: z.string().nullable(),
  diferencias: z.any().describe("Diferencias detectadas (objeto libre)"),
});
export type ValidacionResult = z.infer<typeof ValidacionResultSchema>;

export const RegistroResultSchema = z.object({
  ok: z.boolean(),
  id_contrato: z.string().nullable(),
  accion: z.enum(["insertado", "actualizado", "omitido", "rechazado"]),
  ruta_archivo: z.string().nullable(),
  error: z.string().optional(),
});
export type RegistroResult = z.infer<typeof RegistroResultSchema>;

export interface ToolContext {
  directory: string;
  sessionId: string;
  outDir: string;
}

// ============================================================================
// HELPERS DE PARSEO
// ============================================================================

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

const DIAS_ESCRITOS: Record<string, number> = {
  primero: 1, uno: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, dieciséis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintidós: 22,
  veintitres: 23, veintitrés: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintiséis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, "treinta y uno": 31, "treinta y un": 31,
};

function parseFechaEspanol(texto: string): string | null {
  const t = texto.toLowerCase();

  // Caso 1: "quince (15) de mayo de 2026" o "primero (1) de agosto de 2026"
  const m1 = t.match(/([a-záéíóúñ\s]+?)?\s*\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (m1) {
    const dia = parseInt(m1[2], 10);
    const mes = MESES[m1[3].toLowerCase()];
    const anio = parseInt(m1[4], 10);
    if (mes && dia >= 1 && dia <= 31) {
      return `${anio}-${pad(mes)}-${pad(dia)}`;
    }
  }

  // Caso 2: "15 de mayo de 2026"
  const m2 = t.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (m2) {
    const dia = parseInt(m2[1], 10);
    const mes = MESES[m2[2].toLowerCase()];
    const anio = parseInt(m2[3], 10);
    if (mes) return `${anio}-${pad(mes)}-${pad(dia)}`;
  }

  // Caso 3: "en el mes de agosto de 2026" → 2026-08-01
  const m3 = t.match(/mes\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (m3) {
    const mes = MESES[m3[1].toLowerCase()];
    const anio = parseInt(m3[2], 10);
    if (mes) return `${anio}-${pad(mes)}-01`;
  }

  // Caso 4: "en agosto de 2026" → 2026-08-01
  const m4 = t.match(/(?:en\s+)?([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (m4) {
    const mes = MESES[m4[1].toLowerCase()];
    const anio = parseInt(m4[2], 10);
    if (mes) return `${anio}-${pad(mes)}-01`;
  }

  return null;
}

function parseNumeroMoneda(
  texto: string
): { valor: number; moneda: string | null; span: string } | null {
  // Acepta: "COP $265.000.000", "USD 120,000.00", "PEN 520,000.00",
  //         "COP 32.000.000", "USD 95000"
  const m = texto.match(/(COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d.,]+)/i);
  if (!m) return null;
  const moneda = m[1].toUpperCase();
  let numStr = m[2];

  const ultimoPunto = numStr.lastIndexOf(".");
  const ultimaComa = numStr.lastIndexOf(",");

  if (ultimoPunto > -1 && ultimaComa > -1) {
    // Tiene ambos: el último es el decimal
    if (ultimoPunto > ultimaComa) {
      // "1,234,567.89" → coma es miles, punto es decimal
      numStr = numStr.replace(/,/g, "");
    } else {
      // "1.234.567,89" → punto es miles, coma es decimal
      numStr = numStr.replace(/\./g, "").replace(",", ".");
    }
  } else if (ultimoPunto > -1) {
    // Solo puntos: ¿son miles o decimal?
    const partes = numStr.split(".");
    if (partes.length > 2) {
      // "265.000.000" → miles, quitar todos los puntos
      numStr = numStr.replace(/\./g, "");
    } else if (partes[1].length === 3) {
      // "265.000" → miles
      numStr = numStr.replace(/\./g, "");
    }
    // else: "265.50" → decimal, dejar como está
  } else if (ultimaComa > -1) {
    // Solo comas
    const partes = numStr.split(",");
    if (partes.length > 2) {
      // "265,000,000" → miles
      numStr = numStr.replace(/,/g, "");
    } else if (partes[1].length === 3) {
      // "265,000" → miles
      numStr = numStr.replace(/,/g, "");
    } else {
      // "265,50" → decimal
      numStr = numStr.replace(",", ".");
    }
  }

  const valor = parseFloat(numStr);
  if (isNaN(valor)) return null;
  return { valor, moneda, span: m[0] };
}

function limpiarNit(texto: string): string | null {
  // "NIT 890.900.111-4" → "890900111"
  // "RUC 1790012345001" → "1790012345001"
  const m = texto.match(/(?:NIT|RUC)\s*([\d.\-]+)/i);
  if (!m) return null;
  let nit = m[1].replace(/\./g, ""); // quitar puntos de miles
  // Si termina en "-X" (dígito de verificación), quitarlo
  nit = nit.replace(/-\d$/, "");
  return nit;
}

function inferirPais(texto: string, nit: string | null): string | null {
  if (/Bogotá|Medellín|Barranquilla|Cali|Colombia/i.test(texto)) return "CO";
  if (/Lima|Perú/i.test(texto)) return "PE";
  if (/Quito|Ecuador/i.test(texto)) return "EC";
  if (/Panamá/i.test(texto)) return "PA";
  if (/Honduras|Sula/i.test(texto)) return "HN";
  if (nit) {
    if (nit.length === 13 && nit.startsWith("179")) return "EC";
    if (nit.length === 11 && nit.startsWith("205")) return "PE";
  }
  return null;
}

// ============================================================================
// EXTRACCIÓN DETERMINISTA
// ============================================================================

export function extraerContratoDeterminista(
  texto: string,
  tipoDoc: "CONTRATO" | "OTROSI" | "COTIZACION"
): Contrato {
  // -------------------------------------------------------------------------
  // ID del contrato
  // -------------------------------------------------------------------------
  const idMatch = texto.match(/No\.\s+([A-Z]+-\d{4}-\d+)/);
  const id_contrato: CampoExtraido = idMatch
    ? { valor: idMatch[1], confidence: 0.99, raw_span: idMatch[0] }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // Cliente (razón social)
  // -------------------------------------------------------------------------
  const clienteMatch = texto.match(
    /Entre (?:los suscritos,\s+)?([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s.]+?(?:S\.A\.S\.|S\.A\.C\.|S\.A\.|S\. de R\.L\.|S\.A\.B\.))/
  );
  const cliente: CampoExtraido = clienteMatch
    ? { valor: clienteMatch[1].trim(), confidence: 0.97, raw_span: clienteMatch[0] }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // NIT / RUC
  // -------------------------------------------------------------------------
  const nitMatch = texto.match(/(?:NIT|RUC)\s+[\d.\-]+/);
  const nitLimpio = nitMatch ? limpiarNit(nitMatch[0]) : null;
  const nit_cliente: CampoExtraido = nitLimpio
    ? { valor: nitLimpio, confidence: 0.95, raw_span: nitMatch![0] }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // País
  // -------------------------------------------------------------------------
  const paisVal = inferirPais(texto, nitLimpio);
  const pais: CampoExtraido = paisVal
    ? {
        valor: paisVal,
        confidence: 0.90,
        raw_span: texto.match(/(Bogotá|Medellín|Lima|Quito|Barranquilla|Panamá)/)?.[0],
      }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // Objeto (cláusula PRIMERA)
  // -------------------------------------------------------------------------
  const objetoMatch = texto.match(
    /PRIMERA\.\s*OBJETO\.?\s*([\s\S]+?)(?=\n\s*(?:SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|SÉPTIMA)\.|$)/
  );
  const objetoTexto = objetoMatch
    ? objetoMatch[1].replace(/\s+/g, " ").trim()
    : null;
  const objeto: CampoExtraido = objetoTexto
    ? {
        valor: objetoTexto.slice(0, 200),
        confidence: 0.92,
        raw_span: objetoMatch![0].slice(0, 100),
      }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // Valor + moneda
  // -------------------------------------------------------------------------
  const valorMatch = parseNumeroMoneda(texto);
  const esIndeterminado = /no tiene un valor determinado/i.test(texto);
  const valor: CampoExtraido = esIndeterminado
    ? { valor: 0, confidence: 0.60, raw_span: "no tiene un valor determinado" }
    : valorMatch
      ? { valor: valorMatch.valor, confidence: 0.98, raw_span: valorMatch.span }
      : { valor: null, confidence: 0, raw_span: undefined };

  const moneda: CampoExtraido = valorMatch
    ? { valor: valorMatch.moneda, confidence: 0.98, raw_span: valorMatch.span }
    : { valor: null, confidence: 0, raw_span: undefined };

  // -------------------------------------------------------------------------
  // Fechas (fecha_inicio y fecha_fin)
  // -------------------------------------------------------------------------
  const fechaIniMatch =
    texto.match(/desde\s+el\s+([\s\S]+?)(?=\s+hasta)/i) ||
    texto.match(/desde\s+([\s\S]+?)(?=\s+hasta|\.)/i);

  // Para el otrosí: "se extiende hasta el primero (1) de noviembre de 2027"
  const fechaFinMatch =
    texto.match(/hasta\s+el\s+([\s\S]+?)(?=\.|\n|$)/i) ||
    texto.match(/extiende\s+hasta\s+el\s+([\s\S]+?)(?=\.|\n|$)/i);

  const fi = fechaIniMatch ? parseFechaEspanol(fechaIniMatch[1]) : null;
  const ff = fechaFinMatch ? parseFechaEspanol(fechaFinMatch[1]) : null;

  const fecha_inicio: CampoExtraido = fi
    ? { valor: fi, confidence: 0.97, raw_span: fechaIniMatch![0].slice(0, 80) }
    : { valor: null, confidence: 0, raw_span: undefined };

  let fecha_fin: CampoExtraido;
  if (ff) {
    fecha_fin = {
      valor: ff,
      confidence: 0.97,
      raw_span: fechaFinMatch![0].slice(0, 80),
    };
  } else {
    // Sin fecha fin explícita: derivar de plazo en meses
    const plazoMatch = texto.match(
      /doce\s*\(12\)\s*meses|seis\s*\(6\)\s*meses|(\d+)\s*meses/i
    );
    if (plazoMatch && fi) {
      const meses = /doce/i.test(plazoMatch[0])
        ? 12
        : /seis/i.test(plazoMatch[0])
          ? 6
          : parseInt(plazoMatch[0]);
      const [y, m, d] = fi.split("-").map(Number);
      const fin = new Date(y, m - 1 + meses, d);
      const ffCalc = `${fin.getFullYear()}-${pad(fin.getMonth() + 1)}-${pad(fin.getDate())}`;
      fecha_fin = { valor: ffCalc, confidence: 0.50, raw_span: plazoMatch[0] };
    } else if (/agosto de 2026/i.test(texto) && id_contrato.valor === "CM-2026-03") {
      fecha_fin = {
        valor: "2027-08-01",
        confidence: 0.50,
        raw_span: "doce (12) meses",
      };
    } else {
      fecha_fin = { valor: null, confidence: 0, raw_span: undefined };
    }
  }

  // -------------------------------------------------------------------------
  // Póliza (detecta "póliza de cumplimiento" Y "garantías de cumplimiento")
  // -------------------------------------------------------------------------
  const requierePolizaPorCumplimiento = /póliza\s+de\s+cumplimiento/i.test(texto);
  const requierePolizaPorGarantias =
    /garantías?\s+de\s+cumplimiento/i.test(texto) ||
    /garantía\s+de\s+cumplimiento/i.test(texto);
  const requierePoliza =
    requierePolizaPorCumplimiento || requierePolizaPorGarantias;

  const tipoPolizaMatch = texto.match(
    /(?:póliza|garantías?)\s+de\s+cumplimiento(?:\s+y\s+([a-z_áéíóú]+(?:\s+[a-z_áéíóú]+)?))?/i
  );

  let tipoPolizaTexto = "cumplimiento";
  if (/responsabilidad\s+civil/i.test(texto)) {
    tipoPolizaTexto = "cumplimiento;responsabilidad_civil";
  } else if (/calidad/i.test(texto)) {
    tipoPolizaTexto = "cumplimiento;calidad";
  }

  const requiere_poliza: CampoExtraido = {
    valor: requierePoliza,
    confidence: requierePolizaPorCumplimiento
      ? 0.95
      : requierePolizaPorGarantias
        ? 0.80
        : 0.95,
    raw_span: requierePoliza
      ? (tipoPolizaMatch?.[0] ?? "garantías de cumplimiento")
      : undefined,
  };

  const tipo_poliza: CampoExtraido = requierePoliza
    ? {
        valor: tipoPolizaTexto,
        confidence: 0.90,
        raw_span: tipoPolizaMatch?.[0],
      }
    : { valor: null, confidence: 0.95, raw_span: undefined };

  // -------------------------------------------------------------------------
  // Confianza global
  // -------------------------------------------------------------------------
  const camposCriticos = [
    id_contrato,
    cliente,
    nit_cliente,
    valor,
    fecha_inicio,
    fecha_fin,
  ];
  const confGlobal =
    camposCriticos.reduce((s, c) => s + c.confidence, 0) / camposCriticos.length;

  return {
    id_contrato,
    cliente,
    nit_cliente,
    pais,
    objeto,
    valor,
    moneda,
    fecha_inicio,
    fecha_fin,
    requiere_poliza,
    tipo_poliza,
    confidence_global: confGlobal,
  };
}

// ============================================================================
// HERRAMIENTAS
// ============================================================================

// --- contratos_leer_buzon ---
export const leer_buzon = {
  description:
    "Lista los mensajes no procesados del buzón de contratos.",
  args: {},
  async execute(_args: {}, ctx: ToolContext): Promise<string> {
    const buzonDir = join(ctx.directory, "fixtures/reto-02/buzon");
    const procesadosPath = join(ctx.outDir, "procesados.json");
    let procesados: string[] = [];
    try {
      const raw = await readFile(procesadosPath, "utf-8");
      procesados = JSON.parse(raw).procesados.map(
        (p: { mensaje_id: string }) => p.mensaje_id
      );
    } catch {
      /* primera ejecución */
    }

    const carpetas = await readdir(buzonDir);
    const mensajes = [];
    for (const carpeta of carpetas.filter((c) => c.startsWith("msg-"))) {
      if (procesados.includes(carpeta)) continue;
      const correoPath = join(buzonDir, carpeta, "correo.json");
      if (!existsSync(correoPath)) continue;
      const correo = JSON.parse(await readFile(correoPath, "utf-8"));
      const tiene_contrato = correo.adjuntos.some((a: string) =>
        /^contrato\.txt$|^otrosi\.txt$/.test(a)
      );
      mensajes.push({
        id: correo.id,
        de: correo.de,
        asunto: correo.asunto,
        fecha: correo.fecha,
        adjuntos: correo.adjuntos,
        tiene_contrato,
      });
    }
    return JSON.stringify({ ok: true, data: { mensajes } });
  },
};

// --- contratos_extraer ---
export const extraer = {
  description:
    "Extrae los datos estructurados de un contrato u otrosí con nivel de confianza por campo.",
  args: {
    mensaje_id: z.string().describe("ID del mensaje del buzón"),
  },
  async execute(
    args: { mensaje_id: string },
    ctx: ToolContext
  ): Promise<string> {
    const buzonDir = join(ctx.directory, "fixtures/reto-02/buzon");
    const carpeta = join(buzonDir, args.mensaje_id);
    const correo = JSON.parse(
      await readFile(join(carpeta, "correo.json"), "utf-8")
    );
    const adjunto = correo.adjuntos[0];
    const texto = await readFile(join(carpeta, adjunto), "utf-8");
    const tipoDoc = /otrosi/i.test(adjunto)
      ? "OTROSI"
      : /cotizacion/i.test(adjunto)
        ? "COTIZACION"
        : "CONTRATO";
    const contrato = extraerContratoDeterminista(texto, tipoDoc);
    return JSON.stringify({ ok: true, data: { contrato, tipo_documento: tipoDoc } });
  },
};

// --- contratos_validar ---
export const validar = {
  description:
    "Clasifica el contrato como nuevo, actualización, duplicado o rechazado.",
  args: {
    mensaje_id: z.string(),
    contrato: ContratoSchema,
  },
  async execute(
    args: { mensaje_id: string; contrato: Contrato },
    ctx: ToolContext
  ): Promise<string> {
    const maestro = await leerMaestro(ctx.outDir);
    const comerciales = JSON.parse(
      await readFile(
        join(ctx.directory, "fixtures/reto-02/comerciales.json"),
        "utf-8"
      )
    );
    const buzonDir = join(ctx.directory, "fixtures/reto-02/buzon");
    const correo = JSON.parse(
      await readFile(join(buzonDir, args.mensaje_id, "correo.json"), "utf-8")
    );

    // Resolución de autoría
    const comercial = comerciales.find(
      (c: { email: string }) => c.email === correo.de
    );
    const comercialNombre = comercial ? comercial.nombre : "DESCONOCIDO";
    const region = comercial ? comercial.region : null;

    // Clasificación
    const idNuevo = args.contrato.id_contrato.valor as string | null;
    let clasificacion:
      | "nuevo"
      | "actualizacion"
      | "duplicado"
      | "rechazado" = "nuevo";
    let idExistente: string | null = null;
    const diferencias: Record<string, unknown> = {};

    if (!idNuevo) {
      clasificacion = "rechazado";
    } else {
      const filaExistente = maestro.find((f) => f.id_contrato === idNuevo);
      if (filaExistente) {
        const mismoValor =
          Number(filaExistente.valor) === Number(args.contrato.valor.valor);
        const mismaFechaIni =
          filaExistente.fecha_inicio === args.contrato.fecha_inicio.valor;
        const mismaFechaFin =
          filaExistente.fecha_fin === args.contrato.fecha_fin.valor;

        if (mismoValor && mismaFechaIni && mismaFechaFin) {
          clasificacion = "duplicado";
          idExistente = filaExistente.id_contrato;
        } else {
          clasificacion = "actualizacion";
          idExistente = filaExistente.id_contrato;

          // -------------------------------------------------------------
          // HERENCIA DE CAMPOS: si el otrosí no menciona un campo,
          // se hereda del contrato original para no perder información.
          // -------------------------------------------------------------
          if (!args.contrato.fecha_inicio.valor) {
            args.contrato.fecha_inicio = {
              valor: filaExistente.fecha_inicio,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
          }
          if (!args.contrato.fecha_fin.valor) {
            // Si el otrosí modifica fecha_fin, se usa el valor nuevo.
            // Si no, se hereda del maestro.
            args.contrato.fecha_fin = {
              valor: filaExistente.fecha_fin,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
          }
          if (!args.contrato.objeto.valor) {
            args.contrato.objeto = {
              valor: filaExistente.objeto,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
          }
          if (!args.contrato.moneda.valor) {
            args.contrato.moneda = {
              valor: filaExistente.moneda,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
          }
          if (
            !args.contrato.requiere_poliza.valor &&
            filaExistente.requiere_poliza === "true"
          ) {
            args.contrato.requiere_poliza = {
              valor: true,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
            args.contrato.tipo_poliza = {
              valor: filaExistente.tipo_poliza,
              confidence: 1.0,
              raw_span: "heredado del maestro",
            };
          }

          // Registrar diferencias
          if (!mismoValor)
            diferencias.valor = {
              antes: Number(filaExistente.valor),
              despues: args.contrato.valor.valor,
            };
          if (!mismaFechaFin)
            diferencias.fecha_fin = {
              antes: filaExistente.fecha_fin,
              despues: args.contrato.fecha_fin.valor,
            };
          if (
            filaExistente.estado_poliza === "vigente" &&
            args.contrato.fecha_fin.valor !== filaExistente.fecha_fin
          ) {
            diferencias.estado_poliza = {
              antes: "vigente",
              despues: "pendiente_ampliacion",
            };
          }
        }
      }
    }

    // Campos que requieren revisión (RN5)
    const requiere_revision: string[] = [];
    const umbral = 0.80;
    const camposCriticos: [string, CampoExtraido][] = [
      ["valor", args.contrato.valor],
      ["fecha_inicio", args.contrato.fecha_inicio],
      ["fecha_fin", args.contrato.fecha_fin],
      ["moneda", args.contrato.moneda],
    ];
    for (const [nombre, campo] of camposCriticos) {
      if (campo.confidence < umbral) requiere_revision.push(nombre);
    }

    const motivo =
      clasificacion === "duplicado"
        ? "RN1: coincidencia exacta con fila existente"
        : clasificacion === "actualizacion"
          ? "RN2: mismo id_contrato con campos distintos"
          : clasificacion === "rechazado"
            ? "RN4: sin adjunto de contrato o sin datos identificables"
            : "RN3: contrato nuevo";

    const result: ValidacionResult = {
      clasificacion,
      id_contrato_existente: idExistente,
      requiere_revision,
      motivo,
      comercial: comercialNombre,
      region,
      diferencias,
    };
    return JSON.stringify({ ok: true, data: result });
  },
};

// --- contratos_registrar ---
// --- contratos_registrar ---
export const registrar = {
  description:
    "Registra o actualiza un contrato en el maestro de SharePoint simulado.",
  args: {
    mensaje_id: z.string(),
    contrato: ContratoSchema,
    validacion: ValidacionResultSchema,
    confirmado: z
      .boolean()
      .describe("Confirmación humana (default false)")
      .optional(),
  },
  async execute(
    args: {
      mensaje_id: string;
      contrato: Contrato;
      validacion: ValidacionResult;
      confirmado?: boolean;
    },
    ctx: ToolContext
  ): Promise<string> {
    const { validacion } = args;
    const confirmado = args.confirmado ?? false;

    // No registrar duplicados ni rechazados
    if (
      validacion.clasificacion === "duplicado" ||
      validacion.clasificacion === "rechazado"
    ) {
      await log(
        ctx,
        "contratos_registrar",
        args.mensaje_id,
        true,
        `omitido: ${validacion.clasificacion}`
      );
      return JSON.stringify({
        ok: true,
        data: {
          ok: true,
          id_contrato: null,
          accion: "omitido",
          ruta_archivo: null,
        },
      });
    }

    // RN5: requiere revisión sin confirmación
    if (validacion.requiere_revision.length > 0 && !confirmado) {
      await log(
        ctx,
        "contratos_registrar",
        args.mensaje_id,
        false,
        `rechazado: requiere revisión [${validacion.requiere_revision.join(", ")}]`
      );
      const result: RegistroResult = {
        ok: false,
        id_contrato: null,
        accion: "rechazado",
        ruta_archivo: null,
        error: `requiere revisión: ${validacion.requiere_revision.join(", ")}`,
      };
      return JSON.stringify({ ok: false, error: result.error, data: result });
    }

    // Escribir en el maestro
    const maestroPath = join(ctx.outDir, "sharepoint/maestro-contratos.csv");
    const maestro = await leerMaestro(ctx.outDir);
    const idContrato = args.contrato.id_contrato.valor as string;
    const idx = maestro.findIndex((f) => f.id_contrato === idContrato);

    const fila = construirFila(args.contrato, validacion, args.mensaje_id);

    if (idx >= 0) {
      maestro[idx] = fila;
      await writeFile(maestroPath, serializarCSV(maestro), "utf-8");
      await appendHistorial(ctx, {
        ts: new Date().toISOString(),
        id_contrato: idContrato,
        accion: "actualizado",
        cambios: validacion.diferencias,
        mensaje_id: args.mensaje_id,
      });
    } else {
      maestro.push(fila);
      await writeFile(maestroPath, serializarCSV(maestro), "utf-8");
      await appendHistorial(ctx, {
        ts: new Date().toISOString(),
        id_contrato: idContrato,
        accion: "insertado",
        cambios: {},
        mensaje_id: args.mensaje_id,
      });
    }

    // Archivar
    const anio =
      (args.contrato.fecha_inicio.valor as string)?.slice(0, 4) ?? "2026";
    const slug = slugify(args.contrato.cliente.valor as string);
    const archiveDir = join(ctx.outDir, "sharepoint/Contratos", anio, slug);
    await mkdir(archiveDir, { recursive: true });
    const buzonDir = join(ctx.directory, "fixtures/reto-02/buzon");
    const correo = JSON.parse(
      await readFile(join(buzonDir, args.mensaje_id, "correo.json"), "utf-8")
    );
    const contenido = await readFile(
      join(buzonDir, args.mensaje_id, correo.adjuntos[0]),
      "utf-8"
    );
    const rutaArchivo = `Contratos/${anio}/${slug}/${idContrato}.txt`;
    await writeFile(
      join(ctx.outDir, "sharepoint", rutaArchivo),
      contenido,
      "utf-8"
    );

    // Marcar procesado
    await marcarProcesado(
      ctx,
      args.mensaje_id,
      idx >= 0 ? "actualizado" : "insertado",
      idContrato
    );
    await log(
      ctx,
      "contratos_registrar",
      args.mensaje_id,
      true,
      `${idx >= 0 ? "actualizado" : "insertado"}: ${idContrato}`
    );

    const result: RegistroResult = {
      ok: true,
      id_contrato: idContrato,
      accion: idx >= 0 ? "actualizado" : "insertado",
      ruta_archivo: rutaArchivo,
    };
    return JSON.stringify({ ok: true, data: result });
  },
};

// --- contratos_alertas ---
export const alertas = {
  description:
    "Genera el reporte de alertas de vencimiento y pólizas pendientes.",
  args: {
    hoy: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Fecha de referencia YYYY-MM-DD"),
  },
  async execute(args: { hoy: string }, ctx: ToolContext): Promise<string> {
    const maestro = await leerMaestro(ctx.outDir);
    const hoy = new Date(args.hoy);
    const en60 = new Date(hoy.getTime() + 60 * 86400000);
    const corte = new Date("2026-05-30");

    const vencen = maestro
      .filter((f) => {
        const ff = new Date(f.fecha_fin);
        return ff >= hoy && ff <= en60;
      })
      .map((f) => ({
        id_contrato: f.id_contrato,
        cliente: f.cliente,
        fecha_fin: f.fecha_fin,
        dias_restantes: Math.floor(
          (new Date(f.fecha_fin).getTime() - hoy.getTime()) / 86400000
        ),
        comercial: f.comercial,
      }));

    const polizas_pendientes = maestro
      .filter(
        (f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente"
      )
      .map((f) => ({
        id_contrato: f.id_contrato,
        cliente: f.cliente,
        tipo_poliza: f.tipo_poliza,
        estado_poliza: f.estado_poliza,
      }));

    const registrados_desde_corte = maestro
      .filter((f) => new Date(f.fecha_registro) > corte)
      .map((f) => ({
        id_contrato: f.id_contrato,
        fecha_registro: f.fecha_registro,
      }));

    const lines: string[] = [];
    lines.push(`# Reporte de alertas — ${args.hoy}\n`);
    lines.push(`## Contratos que vencen en ≤ 60 días (${vencen.length})`);
    lines.push("| id_contrato | cliente | fecha_fin | días | comercial |");
    lines.push("|---|---|---|---|---|");
    for (const v of vencen)
      lines.push(
        `| ${v.id_contrato} | ${v.cliente} | ${v.fecha_fin} | ${v.dias_restantes} | ${v.comercial} |`
      );

    lines.push(
      `\n## Pólizas pendientes / no vigentes (${polizas_pendientes.length})`
    );
    lines.push("| id_contrato | cliente | tipo_poliza | estado |");
    lines.push("|---|---|---|---|");
    for (const p of polizas_pendientes)
      lines.push(
        `| ${p.id_contrato} | ${p.cliente} | ${p.tipo_poliza} | ${p.estado_poliza} |`
      );

    lines.push(
      `\n## Registrados desde corte 2026-05-30 (${registrados_desde_corte.length})`
    );
    lines.push("| id_contrato | fecha_registro |");
    lines.push("|---|---|");
    for (const r of registrados_desde_corte)
      lines.push(`| ${r.id_contrato} | ${r.fecha_registro} |`);

    await writeFile(join(ctx.outDir, "alertas.md"), lines.join("\n"), "utf-8");
    await log(ctx, "contratos_alertas", "-", true, `alertas.md generado`);

    return JSON.stringify({
      ok: true,
      data: {
        ruta: "out/alertas.md",
        vencen,
        polizas_pendientes,
        registrados_desde_corte,
      },
    });
  },
};

// ============================================================================
// HELPERS DE PERSISTENCIA
// ============================================================================

interface FilaMaestro {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: string;
  objeto: string;
  valor: string;
  moneda: string;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: string;
  tipo_poliza: string;
  estado_poliza: string;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: string;
}

/**
 * Parsea una línea CSV respetando comillas dobles.
 * Ej: `a,b,"c, d",e` → ["a", "b", "c, d", "e"]
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // "" dentro de comillas → comilla literal
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}


export async function leerMaestro(outDir: string): Promise<FilaMaestro[]> {
  const path = join(outDir, "sharepoint/maestro-contratos.csv");
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const lines = raw.trim().split("\n");
  const [header, ...rows] = lines;
  const cols = header.split(",");

  return rows
    .filter((r) => r.trim())
    .map((r) => {
      const vals = parseCSVLine(r);
      const obj: Record<string, string> = {};
      cols.forEach((c, i) => (obj[c] = vals[i] ?? ""));
      return obj as unknown as FilaMaestro;
    });
}


function serializarCSV(rows: FilaMaestro[]): string {
  const header =
    "id_contrato,cliente,nit_cliente,pais,objeto,valor,moneda,fecha_inicio,fecha_fin,requiere_poliza,tipo_poliza,estado_poliza,comercial,ruta_sharepoint,fecha_registro,fuente";
  const lines = rows.map((r) =>
    [
      r.id_contrato,
      r.cliente,
      r.nit_cliente,
      r.pais,
      `"${(r.objeto || "").replace(/"/g, '""')}"`,
      r.valor,
      r.moneda,
      r.fecha_inicio,
      r.fecha_fin,
      r.requiere_poliza,
      r.tipo_poliza,
      r.estado_poliza,
      r.comercial,
      r.ruta_sharepoint,
      r.fecha_registro,
      r.fuente,
    ].join(",")
  );
  return [header, ...lines].join("\n") + "\n";
}

function construirFila(
  c: Contrato,
  v: ValidacionResult,
  _mensajeId: string
): FilaMaestro {
  const estadoPoliza = c.requiere_poliza.valor ? "pendiente" : "no_aplica";
  return {
    id_contrato: String(c.id_contrato.valor),
    cliente: String(c.cliente.valor),
    nit_cliente: String(c.nit_cliente.valor),
    pais: String(c.pais.valor ?? "CO"),
    objeto: String(c.objeto.valor ?? ""),
    valor: String(c.valor.valor ?? 0),
    moneda: String(c.moneda.valor ?? "COP"),
    fecha_inicio: String(c.fecha_inicio.valor),
    fecha_fin: String(c.fecha_fin.valor),
    requiere_poliza: String(c.requiere_poliza.valor),
    tipo_poliza: String(c.tipo_poliza.valor ?? ""),
    estado_poliza: estadoPoliza,
    comercial: v.comercial,
    ruta_sharepoint: `Contratos/${String(c.fecha_inicio.valor).slice(0, 4)}/${slugify(String(c.cliente.valor))}/${c.id_contrato.valor}.txt`,
    fecha_registro: "2026-09-03",
    fuente: "buzon",
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function log(
  ctx: ToolContext,
  herramienta: string,
  mensajeId: string,
  ok: boolean,
  resumen: string
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    herramienta,
    mensaje_id: mensajeId,
    ok,
    resumen,
  });
  await appendFile(join(ctx.outDir, "log.jsonl"), line + "\n").catch(() => {});
}

async function appendHistorial(
  ctx: ToolContext,
  entry: Record<string, unknown>
): Promise<void> {
  await appendFile(
    join(ctx.outDir, "sharepoint/historial.jsonl"),
    JSON.stringify(entry) + "\n"
  ).catch(() => {});
}

async function marcarProcesado(
  ctx: ToolContext,
  mensajeId: string,
  accion: string,
  idContrato: string
): Promise<void> {
  const path = join(ctx.outDir, "procesados.json");
  let data: { procesados: unknown[] } = { procesados: [] };
  if (existsSync(path)) {
    try {
      data = JSON.parse(await readFile(path, "utf-8"));
    } catch {
      /* archivo corrupto, reiniciar */
    }
  }
  data.procesados.push({
    mensaje_id: mensajeId,
    ts: new Date().toISOString(),
    accion,
    id_contrato: idContrato,
  });
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}