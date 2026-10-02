# SOLUCION.md — Agente de Registro de Contratos Vigentes

> Reto técnico 02 · Periferia IT Group · Perxia 2.0
> Candidato: José Andrés Parra Ochoa
> Fecha: 2026-10-01

---

## 1. Problema en una frase y a quién le duele

**El maestro de contratos de Periferia está congelado desde el 2026-05-30 y no hay un punto único de recepción**, por lo que la dirección no puede responder "¿qué contratos vencen este trimestre?" ni anticipar pólizas que expiran.

**Le duele a:**

- **Gerencia**: no tiene visibilidad de vigencias ni del riesgo contractual.
- **Analista administrativa**: recibe contratos dispersos por correo, sin responsable único.
- **Comerciales**: no tienen un canal claro para entregar contratos y quedan expuestos a incumplimientos.
- **La empresa**: depende de una sola persona (el aprendiz que se fue) y pierde memoria institucional cuando hay rotación.

---

## 2. Arquitectura

### 2.1 Diagrama de extremo a extremo

```
┌──────────────────────────┐
│  Front de chat           │  web/index.html
│  - historial             │  ─ HTTP/JSON ─▶
│  - tool calls visibles   │
│  - banner de confirmación│
└──────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Backend (Node 24 + TypeScript)                              │
│                                                              │
│  ┌────────────────────────────────────────────────────┐      │
│  │  Ciclo del agente (src/agent/loop.ts)              │      │
│  │  - tope 25 iteraciones                             │      │
│  │  - validación de args con Zod                      │      │
│  │  - confirmación humana (needsConfirmation)         │      │
│  └────────────────────────────────────────────────────┘      │
│              │                                                │
│              ▼                                                │
│  ┌──────────────────────┐    ┌───────────────────────────┐   │
│  │  Adaptador LLM       │    │  Herramientas (Zod)       │   │
│  │  src/llm/*.ts        │    │  src/tools/contratos.ts   │   │
│  │  - interfaz única    │    │  - leer_buzon             │   │
│  │  - OpenAI-compatible │    │  - extraer                │   │
│  └──────────────────────┘    │  - validar                │   │
│              │               │  - registrar              │   │
│              ▼               │  - alertas                │   │
│  ┌──────────────────────┐    └───────────────────────────┘   │
│  │  System prompt       │                  │                  │
│  │  agent/prompt.md     │                  │                  │
│  └──────────────────────┘                  │                  │
│                                            ▼                  │
└──────────────────────────────────────────────────────────────┘
              │                                            │
              ▼                                            ▼
   ┌────────────────────┐                    ┌──────────────────────┐
   │  fixtures/reto-02/ │  (solo lectura)    │  out/                │
   │  - buzon/          │                    │  - sharepoint/       │
   │  - maestro.csv     │                    │    maestro.csv       │
   │  - comerciales.json│                    │    historial.jsonl   │
   └────────────────────┘                    │    Contratos/...     │
                                             │  - procesados.json   │
                                             │  - alertas.md        │
                                             │  - log.jsonl         │
                                             └──────────────────────┘
```

### 2.2 Separación de responsabilidades

| Capa | Archivo | Responsabilidad | Cambia cuando… |
|---|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo decide y se comunica el agente | Cambian las reglas de negocio |
| **Conocimiento** | `src/knowledge/registro-contratos.md` | Contexto del proceso, estados, RN1–RN7 | Cambia el proceso operativo |
| **Ejecución** | `src/tools/contratos.ts` | Extracción, validación, registro, alertas | Cambia la lógica de datos |
| **Orquestación** | `src/agent/loop.ts` | Bucle del agente, validación Zod, logging | Raramente |
| **Transporte** | `src/server.ts`, `web/` | API HTTP y UI | Raramente |
| **Proveedor LLM** | `src/llm/*.ts` | Interfaz con el modelo | Cambias de proveedor |

**Regla de oro**: un cambio en las reglas de negocio toca **solo** `agent/prompt.md` y `src/knowledge/`. Nunca el servidor.

---

## 3. Ciclo del agente

### 3.1 Implementación

El ciclo vive en `src/agent/loop.ts`. Es un bucle **modelo → herramienta → modelo** con tope de iteraciones.

```
┌──────────────────────────────────────────────────────────────┐
│  1. Construir mensajes: [system, ...historial, user]         │
│  2. Llamar al LLM con las herramientas disponibles           │
│  3. ¿El LLM devolvió tool_calls?                             │
│     ├── NO  → terminar turno, devolver contenido             │
│     └── SÍ  → por cada tool_call:                            │
│              a. Validar args con Zod                         │
│              b. Ejecutar herramienta                         │
│              c. Registrar en out/log.jsonl                   │
│              d. Agregar resultado como mensaje "tool"        │
│  4. Repetir hasta tope (25) o hasta que no haya tool_calls   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Reglas del ciclo (CA1–CA5 del PRD)

| Regla | Implementación |
|---|---|
| **CA1** Tope de iteraciones | `MAX_ITER = 25` en `loop.ts`. Al alcanzarlo, responde con lo que tiene. |
| **CA2** El modelo no afirma valores que no salgan de herramientas | El system prompt lo prohíbe. Además, el diseño lo hace innecesario: el LLM solo enruta, los datos salen de `contratos_extraer`. |
| **CA3** Confirmación humana | Cuando `contratos_registrar` devuelve `ok: false` con `error: "requiere revisión: ..."`, el LLM termina el turno con pregunta explícita. El front resalta el banner rojo. Solo procede si el usuario confirma. |
| **CA4** Logging de tool calls | `out/log.jsonl` con `{ ts, herramienta, ok, resumen, args }`. Además, el front muestra cada tool call al usuario. |
| **CA5** Errores no matan la sesión | Cada `execute` retorna `{ ok: false, error }`. El `loop.ts` envuelve todo en try/catch y sigue con el siguiente mensaje. |

### 3.3 Confirmación humana — flujo detallado

```
Usuario: "Procesa el buzón"
         │
         ▼
Agente:  leer_buzon → extraer × 6 → validar × 6
         registrar × 3 (msg-001, 002, 003) ✅
         registrar × 1 (msg-004) → omitido (duplicado)
         registrar × 1 (msg-005) → omitido (rechazado)
         registrar × 1 (msg-006) → ❌ "requiere revisión: valor, fecha_inicio, fecha_fin"
         │
         ▼
Agente:  "Encontré un contrato marco de Distribuidora Caribe (CM-2026-03).
         Necesito confirmar:
         - valor: 0 (contrato sin valor determinado)
         - fecha_inicio: 2026-08-01
         - fecha_fin: 2027-08-31 (12 meses desde agosto 2026)
         - remitente jperez@... no está en comerciales.json
         ¿Confirmas el registro?"

Usuario: "Sí, confirmo"
         │
         ▼
Agente:  registrar(confirmado=true) → insertado: CM-2026-03
         alertas(hoy=2026-09-03) → out/alertas.md
         │
         ▼
Agente:  "Registré CM-2026-03. Reporte de alertas generado:
         - 1 contrato vence en ≤ 60 días
         - 3 pólizas pendientes"
```

---

## 4. Elección del modelo

### 4.1 Modelo recomendado

**`gpt-4o-mini`** (OpenAI) por defecto, pero el adaptador es **compatible con cualquier API OpenAI Chat Completions**:

| Proveedor | Modelo | Por qué |
|---|---|---|
| OpenAI | `gpt-4o-mini` | Mejor relación costo/calidad para tool calling |
| Anthropic | `claude-3-5-haiku` | Alternativa económica, buen tool use |
| Groq | `llama-3.3-70b-versatile` | Muy rápido, bajo costo |
| DeepSeek | `deepseek-chat` | El más económico, buen razonamiento |
| Local (Ollama) | `qwen2.5:14b` | Sin costo de API, requiere hardware |

### 4.2 Costo estimado por caso procesado

Con `gpt-4o-mini` (`$0.15 / 1M tokens input`, `$0.60 / 1M tokens output`):

| Operación | Tokens input | Tokens output | Costo |
|---|---|---|---|
| `leer_buzon` | ~500 | ~300 | $0.0003 |
| `extraer` × 6 (uno por mensaje) | ~9,000 | ~2,400 | $0.0028 |
| `validar` × 6 | ~5,000 | ~1,800 | $0.0018 |
| `registrar` × 4 | ~3,500 | ~1,200 | $0.0013 |
| `alertas` | ~800 | ~400 | $0.0004 |
| **Total por buzón completo (6 mensajes)** | **~18,800** | **~6,100** | **~$0.0066 USD** |

**Proyección mensual** (estimando 200 mensajes/mes):
- ~$0.22 USD/mes con `gpt-4o-mini`
- ~$0.05 USD/mes con `deepseek-chat`
- ~$1.80 USD/mes con `gpt-4o`

### 4.3 Límites de gasto

Configurados en el adaptador:
- `max_tokens: 4096` por llamada.
- `MAX_ITER = 25` por turno.
- Timeout de 60s por llamada al LLM.

Esto evita que un usuario malicioso o un loop infinito queme la API key.

---

## 5. Estrategia de extracción

### 5.1 Enfoque híbrido determinista + LLM

| Campo | Método | Confianza base | Refuerzo con LLM |
|---|---|---|---|
| `id_contrato` | Regex `No\. [A-Z]+-\d{4}-\d+` | 0.99 | No necesario |
| `cliente` | Regex de razón social después de "Entre" | 0.97 | Valida contra `comerciales.json` |
| `nit_cliente` | Regex `NIT|RUC` + limpieza | 0.95 | No necesario |
| `pais` | Inferencia por ciudad + longitud de NIT | 0.90 | Valida con LLM si < 0.85 |
| `objeto` | Cláusula PRIMERA hasta SEGUNDA | 0.92 | Truncado a 200 chars |
| `valor` | Regex de moneda + normalización | 0.98 | Detecta "no determinado" |
| `moneda` | Capturada con el valor | 0.98 | — |
| `fecha_inicio` | Parser de fecha en español | 0.97 | Fallback si solo hay mes |
| `fecha_fin` | Parser o cálculo desde plazo | 0.97 / 0.50 | LLM propone si es ambiguo |
| `requiere_poliza` | Regex "póliza de cumplimiento" | 0.95 | Cuerpo del correo refuerza |

### 5.2 Cálculo de confianza

Cada campo tiene una confianza `[0, 1]` que refleja:

- **1.0**: valor explícito y sin ambigüedad.
- **0.9–0.99**: valor explícito con formato estándar.
- **0.7–0.89**: valor inferido por heurística fuerte.
- **0.5–0.69**: valor derivado (cálculo, inferencia débil).
- **0**: valor ausente.

**Confianza global** = promedio de campos críticos (`id_contrato`, `cliente`, `nit_cliente`, `valor`, `fecha_inicio`, `fecha_fin`).

**Umbral RN5**: si algún campo crítico tiene confianza `< 0.8`, se marca como `requiere_revision`.

### 5.3 Dónde entra el LLM y dónde no

| Fase | ¿LLM? | Por qué |
|---|---|---|
| Clasificación del correo | **Opcional** | Las señales regex son suficientes (asunto, extensión, palabras clave). El LLM ayuda con casos ambiguos. |
| Extracción de campos | **No en primera pasada** | La extracción determinista es P0 según el PRD. El LLM solo enriquece si falla. |
| Validación contra maestro | **No** | Es determinista: comparación de strings y números. |
| Resolución de autoría | **No** | Cruce exacto con `comerciales.json`. |
| Detección de duplicados | **No** | RN1 es exacta. RN2 usa similitud coseno determinista. |
| Redacción de respuestas | **Sí** | El LLM convierte resultados estructurados en lenguaje natural. |

**Principio**: el LLM **no produce datos**. Solo los presenta.

---

## 6. Regla de gobierno (sección 7.5 del PRD)

### Propuesta: "Regla de Gobierno del Registro de Contratos Vigentes"

**Vigencia**: desde la aprobación por Gerencia.
**Dueño del proceso**: Dirección Administrativa (dueña del maestro).
**Aprobador de excepciones**: Gerencia General.

---

#### 6.1 Canal único

- **Dirección oficial**: `contratos@periferia.com` (buzón corporativo administrado por Dirección Administrativa).
- **Administración**: Dirección Administrativa designa un responsable y un suplente.
- **Prohibición**: queda prohibido enviar contratos a correos personales o a otras áreas. Los contratos recibidos por canales no oficiales se redirigen al buzón y se reportan como incumplimiento.

#### 6.2 Obligación del comercial

Todo comercial que cierre un contrato debe enviar al buzón único, **dentro de los 5 días hábiles siguientes a la firma**:

| Documento | Formato | Obligatorio |
|---|---|---|
| Contrato firmado por ambas partes | PDF con texto (no escaneado) | ✅ Sí |
| Otrosí firmado (si aplica) | PDF con texto | ✅ Sí |
| Acta de terminación (si aplica) | PDF con texto | ✅ Sí |
| Anexos técnicos o económicos | PDF | Opcional |

**Formato del asunto** (obligatorio):

```
[TIPO] <Cliente> - <Objeto corto> - <Año>

Ejemplos:
[CONTRATO] Industrias Delta - Implementación CRM - 2026
[OTROSÍ] Minera Los Andes - Ampliación plazo - 2026
```

**Cuerpo del correo** debe incluir:
- Nombre completo del comercial.
- Región.
- Si requiere póliza (sí/no) y tipo.
- Cualquier condición especial.

#### 6.3 Acuse automático

El agente responde al remitente **en menos de 5 minutos** con:

```
Recibido. Tu contrato <id_contrato> fue procesado:
- Estado: <nuevo | actualizacion | duplicado | rechazado>
- Registrado en maestro: <sí | no | pendiente de revisión>
- Póliza: <no_aplica | pendiente | vigente>
- Archivado en: <ruta_sharepoint>
```

Si algún campo requiere revisión, se envía un segundo correo al comercial pidiendo confirmación con copia a Dirección Administrativa.

#### 6.4 Excepciones y escalamiento

| Situación | Acción | Escala a |
|---|---|---|
| Contrato sin firmar | No registrar. Notificar al comercial. Plazo: 5 días hábiles para corregir. | Dirección Administrativa |
| Contrato sin valor | No registrar. Solicitar valor o cláusula de valor indeterminado. | Dirección Administrativa |
| Contrato en idioma distinto al español | Traducir con traductor oficial. Registrar con nota. | Dirección Administrativa |
| Remitente no registrado en `comerciales.json` | Registrar con comercial `DESCONOCIDO` y notificar a Dirección Administrativa. | Dirección Administrativa |
| Conflicto entre contrato y maestro (ej. mismo id, distinto valor) | No registrar. Escalar a Dirección Administrativa para decisión. | Dirección Administrativa + Gerencia |
| Intento de registrar un contrato retroactivo (posterior a la firma) | Requiere aprobación explícita de Gerencia. | Gerencia |

#### 6.5 Cierre del gap junio–agosto 2026

El maestro quedó congelado al 2026-05-30. Entre esa fecha y hoy (2026-09-03) hay contratos firmados que no fueron registrados. Plan de cierre:

1. **Campaña de recuperación** (una sola vez): Dirección Administrativa solicita a todos los comerciales el envío de los contratos firmados entre 2026-05-30 y 2026-09-03, con plazo de 15 días calendario.
2. **Procesamiento masivo**: el agente procesa todos los correos de la campaña. Los que requieran revisión se marcan y se gestionan en lote.
3. **Validación cruzada**: se contrasta contra facturación para detectar contratos que facturaron sin estar en el maestro.
4. **Cierre formal**: al finalizar la campaña, se declara el maestro actualizado al 2026-09-30.

#### 6.6 Indicador mensual

**Nombre**: *Tasa de cobertura del maestro*
**Fórmula**:

```
Tasa = (contratos activos en el maestro) / (contratos facturados en el mes) × 100
```

**Meta**: ≥ 95%
**Dueño del indicador**: Dirección Administrativa
**Reporte**: mensual a Gerencia, primer lunes de cada mes.
**Acción si < 90%**: se activa una campaña de recuperación con plazo de 10 días.

**Indicadores secundarios**:
- Tiempo medio de registro desde la firma (meta: ≤ 5 días hábiles).
- % de contratos con campos en revisión (meta: ≤ 10%).
- % de contratos con póliza vigente al día (meta: ≥ 98%).

---

## 7. Decisiones y trade-offs

### 7.1 Extracción determinista vs. extracción con LLM

**Decisión**: usar extracción determinista (regex + heurísticas) como P0, con el LLM solo como fallback.

**Alternativa descartada**: dejar que el LLM extraiga todos los campos.

**Por qué**:
- **Costo**: extraer 6 contratos con LLM cuesta ~$0.003 vs. ~$0.0001 con regex.
- **Determinismo**: `demo.ts` debe producir el mismo resultado en cada ejecución. El LLM introduce variabilidad.
- **Auditabilidad**: cada valor tiene un `raw_span` que respalda la extracción. Con LLM puro, ese span no existe.

**Trade-off aceptado**: algunos campos ambiguos (como `fecha_fin` derivada de plazo) tienen confianza baja y requieren revisión humana. Es el precio de la honestidad.

### 7.2 Confirmación humana obligatoria vs. registro automático con confianza baja

**Decisión**: exigir confirmación humana cuando algún campo crítico tiene confianza < 0.8 (RN5).

**Alternativa descartada**: registrar automáticamente con el valor más probable y marcar para revisión posterior.

**Por qué**:
- **Integridad del maestro**: es peor un dato malo que un dato faltante. El PRD exige "cero filas duplicadas" y "no corromper el maestro".
- **Confianza del usuario**: la analista administrativa necesita saber qué está dudoso, no descubrirlo después.
- **Cumplimiento**: en un contrato, un valor mal registrado puede tener consecuencias legales.

**Trade-off aceptado**: más interacción humana. En la práctica, solo `msg-006` de 6 casos requirió confirmación (~17% de los casos).

### 7.3 Adaptador LLM con interfaz propia vs. SDK del proveedor

**Decisión**: definir `LLMAdapter` en `src/llm/adapter.ts` e implementar un adaptador OpenAI-compatible.

**Alternativa descartada**: usar directamente el SDK de OpenAI (o Anthropic) en el ciclo del agente.

**Por qué**:
- **Portabilidad**: cambiar de OpenAI a Groq, DeepSeek, Together o un modelo local requiere solo cambiar `LLM_BASE_URL` y `LLM_MODEL`. Cero cambios en `loop.ts`.
- **Testing**: el adaptador se puede mockear fácilmente en pruebas.
- **Seguridad**: la API key solo se lee del entorno en un solo punto.

**Trade-off aceptado**: no se aprovechan features específicas del proveedor (ej. prompt caching de Anthropic). Se puede extender después con un adaptador específico.

### 7.4 Persistencia en archivos vs. base de datos

**Decisión**: usar archivos en `out/` (CSV, JSONL, Markdown).

**Alternativa descartada**: SQLite o Postgres embebido.

**Por qué**:
- **Simplicidad**: el PRD lo permite explícitamente ("El maestro es un CSV; SharePoint es una carpeta local").
- **Auditabilidad**: `historial.jsonl` es inspeccionable con `cat` o `grep`. Una base de datos requiere herramientas.
- **Portabilidad**: el repo funciona sin setup adicional.

**Trade-off aceptado**: no hay concurrencia segura. En producción con múltiples usuarios se necesitaría un lock o una base de datos.

---

## 8. Supuestos

| # | Supuesto | Impacto si es falso |
|---|---|---|
| 1 | Los contratos llegan como texto extraíble (no escaneados). | Se necesita OCR. El PRD lo reconoce como riesgo. |
| 2 | Los comerciales siguen la regla de gobierno. | El maestro queda incompleto, igual que hoy. El agente solo procesa lo que llega. |
| 3 | El maestro es de solo lectura en `fixtures/`; se escribe en `out/`. | Si se escribe en `fixtures/`, se contamina el fixture entregado. Mitigado con RN6. |
| 4 | El `id_contrato` es único dentro del maestro. | Si hay colisiones, el detector de duplicados fallaría. Mitigado con RN1 + RN2. |
| 5 | El campo `valor` es numérico sin separadores. | Si trae separadores, el parser los normaliza. |
| 6 | Los países soportados son CO, EC, PE, PA, HN. | Si aparece otro, el campo `pais` queda `null` con confianza 0. |
| 7 | El "hoy" de referencia es 2026-09-03. | Se pasa como argumento a `contratos_alertas` para determinismo. |
| 8 | Los correos del buzón son legítimos y no maliciosos. | No hay validación de contenido malicioso (fuera del alcance). |

---

## 9. Cobertura de historias de usuario

| HU | Descripción | Estado | Detalle |
|---|---|---|---|
| **HU-1** | Leer el buzón | ✅ Hecho | `contratos_leer_buzon` lista no procesados con `tiene_contrato`. |
| **HU-2** | Extraer datos del contrato | ✅ Hecho | `contratos_extraer` con `confianza` por campo. Determinista P0. |
| **HU-3** | Validar y clasificar | ✅ Hecho | `contratos_validar` con RN1–RN5. Autoría desde `comerciales.json`. |
| **HU-4** | Registrar y archivar | ✅ Hecho | `contratos_registrar` con `confirmado` y archivado en `out/sharepoint/`. |
| **HU-5** | Alertar | ✅ Hecho | `contratos_alertas` con 3 secciones y fecha `hoy` parametrizable. |
| **HU-6** | Manejo de errores | ✅ Hecho | Cada `execute` retorna `{ ok, data }` o `{ ok: false, error }`. El loop no aborta. |
| **RN1** | Duplicado | ✅ Hecho | `msg-004` verificado. |
| **RN2** | Actualización | ✅ Hecho | `msg-003` verificado, preserva historial. |
| **RN3** | Nuevo | ✅ Hecho | `msg-001`, `msg-002` verificados. |
| **RN4** | Rechazado | ✅ Hecho | `msg-005` verificado. |
| **RN5** | Revisión por confianza | ✅ Hecho | `msg-006` verificado. |
| **RN6** | Fixture solo lectura | ✅ Hecho | `fixtures/` nunca se escribe. |
| **RN7** | `log.jsonl` | ✅ Hecho | Cada tool call deja una línea. |
| **CA1** | Tope de iteraciones | ✅ Hecho | `MAX_ITER = 25`. |
| **CA2** | No afirmar valores fuera de herramientas | ✅ Hecho | Prompt + diseño. |
| **CA3** | Confirmación humana | ✅ Hecho | Banner en front + `needsConfirmation`. |
| **CA4** | Tool calls visibles | ✅ Hecho | Front + `out/log.jsonl`. |
| **CA5** | Errores no matan la sesión | ✅ Hecho | Try/catch en loop y server. |
| **Bonus** | Módulo reutilizable | ⚠️ Parcial | Ver `modulo/` (agent.md + tools + skill). |
| **P1** | `contratos_leer_pdf` | ⏳ No hecho | Fuera del alcance P0. Stub documentado. |

**Cobertura P0**: 100%. **Cobertura P1**: 0% (documentado como opcional). **Bonus**: parcial.

---

## 10. Uso de IA durante el desarrollo

| Asistente | Tarea | Aporte | Descartado |
|---|---|---|---|
| **Claude (Sonnet 4.5)** | Diseño de arquitectura, generación de esquemas Zod, redacción del prompt | Estructura multi-agente, validación de contratos, borradores iniciales de cada herramienta | Sugerencias de usar LangChain (innecesario para el alcance). |
| **ChatGPT (GPT-4)** | Revisión de la lógica de detección de duplicados, ayuda con regex de fechas en español | Patrones de regex robustos para "quince (15) de mayo de 2026" | Sugerencia de usar embeddings para similitud (descartado por costo). |
| **GitHub Copilot** | Autocompletado de boilerplate (server, frontend, tipos) | Velocidad de escritura | — |

**Cómo se validó**: todo el código entregado fue **revisado línea por línea** por el candidato. Los patrones regex se probaron contra los 6 contratos reales del buzón. Los esquemas Zod se validaron con `safeParse`. La salida de `demo.ts` se inspeccionó caso por caso.

**Qué se descartó**:
- Framework pesado (LangChain, Vercel AI SDK) → el PRD pide separación clara, no un framework.
- Base de datos → el PRD permite archivos.
- Embeddings para duplicados → la similitud coseno de strings es suficiente para los casos del reto.

---

## 11. Riesgos de llevar esto a producción

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| **Contratos escaneados** (OCR necesario) | Alta | Alto | Integrar Tesseract o servicio de OCR. Costo: ~$0.01/página. |
| **Volumen alto** (cientos de contratos/mes) | Media | Medio | Cola de procesamiento (BullMQ, RabbitMQ) + procesamiento en background. |
| **Cambios en formato de contratos** | Alta | Medio | Monitorear tasa de `requiere_revision`. Si sube, ajustar regex. |
| **Alucinación del LLM en respuestas** | Media | Bajo | El LLM no produce datos, solo presenta. Los datos salen de herramientas. |
| **Fallo del proveedor LLM** | Media | Medio | Fallback a otro proveedor vía `LLM_BASE_URL`. Alternativa: modo determinista sin LLM (el mismo `demo.ts`). |
| **Concurrencia en `out/`** | Baja (un usuario) | Alto (múltiples) | Lock por archivo o migrar a Postgres. |
| **Seguridad de la API key** | Baja | Alto | Solo en variable de entorno del backend. Nunca en logs ni respuestas. |
| **Cumplimiento de la regla de gobierno** | Alta (adopción) | Alto | Capacitación a comerciales + indicador mensual + escalamiento. |
| **Pérdida de datos históricos** | Baja | Alto | Backup diario de `out/sharepoint/`. Versionado con git si es posible. |
| **Contratos con cláusulas complejas** (ej. valor por demanda, condiciones) | Media | Medio | El agente marca `requiere_revision` cuando no está seguro. La analista decide. |

**Riesgo mayor**: el proceso depende de que los comerciales usen el canal único. Sin esa adopción, el agente solo procesa lo que le llega, igual que hoy. La regla de gobierno y el indicador mensual son la mitigación principal.

---

## Apéndice A: Cómo correr el proyecto

```bash
# Requisitos: Node 20+
node --version  # >= 20

# 1. Instalar dependencias
npm install

# 2. Configurar API key
cp .env.example .env
# editar .env con LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

# 3. Correr demo determinista (sin LLM, sin API key)
npm run demo

# 4. Correr el agente conversacional
npm run dev
# Abrir http://localhost:3000
```

## Apéndice B: Prompt de ejemplo para el chat

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Resultado esperado:
1. Tool calls visibles: `leer_buzon`, 6× `extraer`, 6× `validar`, 4× `registrar`.
2. `msg-006` bloqueado, banner de confirmación.
3. Tras "sí, confirmo": `registrar(confirmado=true)` + `alertas`.
4. Tabla resumen + `out/alertas.md`.

## Apéndice C: Estructura del repositorio

```
reto-02/
├── agent/
│   └── prompt.md
├── src/
│   ├── server.ts
│   ├── agent/loop.ts
│   ├── llm/{adapter,openai}.ts
│   ├── tools/{contratos,registry}.ts
│   └── knowledge/registro-contratos.md
├── web/index.html
├── fixtures/reto-02/         ← entregados, solo lectura
├── out/                      ← generado, no versionado
├── demo.ts
├── .env.example
├── package.json
├── tsconfig.json
├── README.md
└── SOLUCION.md
```

---

*Documento generado como parte del entregable del Reto 02 — Periferia IT Group.*
