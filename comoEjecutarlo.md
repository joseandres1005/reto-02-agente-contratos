
🔧 Cómo ejecutarlo

# 1. Instalar dependencias
npm install

# 2. Configurar API key
cp .env.example .env
# editar .env con tu LLM_API_KEY

# 3. Cargar variables y arrancar
node --env-file=.env --import tsx src/server.ts
# o simplemente:
npm run dev

# 4. Abrir el chat
# http://localhost:3000


En el chat escribe:

text
Procesa el buzón con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.