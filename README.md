# Seguimiento

Página estática que muestra el recorrido de una guardia de Sentinel a partir de
un enlace con token (`#t=...`). Solo consulta la función `get_tracking` de
Supabase, que valida el token y su vencimiento (3 días).
