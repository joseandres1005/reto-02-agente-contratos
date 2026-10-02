# Proceso de registro de contratos

## Entrada

- Buzón único: contratos@periferia-ficticia.com
- Remitente: comercial (lgomez, cruiz, amolina) o aprendiz (jperez)
- Adjuntos: contrato.txt, otrosi.txt, cotizacion.txt

## Salida

- Maestro: out/sharepoint/maestro-contratos.csv
- Historial: out/sharepoint/historial.jsonl
- Archivo: out/sharepoint/Contratos/<año>/<cliente-slug>/<id>.<ext>
- Alertas: out/alertas.md
- Procesados: out/procesados.json
- Log: out/log.jsonl

## Estados de póliza

- `no_aplica`: no requiere póliza
- `pendiente`: requiere y aún no se ha constituido
- `vigente`: constituida y activa
- `vencida`: constituida pero expirada
- `pendiente_ampliacion`: requiere ampliación tras un otrosí

## Reglas de negocio

- **RN1**: duplicado exacto (mismo id + valor + fechas) → no escribir.
- **RN2**: actualización (mismo id + campos distintos) → actualizar fila + historial.
- **RN3**: nuevo → insertar.
- **RN4**: sin contrato o sin partes → rechazar.
- **RN5**: campo crítico con confianza < 0.8 → requiere_revision.
- **RN6**: fixture solo lectura, copiar a out/ la primera vez.
- **RN7**: log.jsonl por cada tool call.

## Casos del buzón (referencia)

| Mensaje | Tipo | Resultado esperado |
|---|---|---|
| msg-001 | Contrato nuevo con póliza | insertado, estado_poliza=pendiente |
| msg-002 | Contrato nuevo sin póliza | insertado, no_aplica |
| msg-003 | Otrosí | actualizado, preserva historial |
| msg-004 | Reenvío | duplicado, sin escritura |
| msg-005 | Cotización | rechazado |
| msg-006 | Contrato marco | requiere_revision hasta confirmar |