UPDATE assistant_cleanup AS cleanup_row
SET data = json_set(
  cleanup_row.data,
  '$.charges',
  json(COALESCE(
    (
      SELECT json_group_array(json(
        CASE
          WHEN json_type(charge.value, '$.conversationId') = 'text'
            THEN charge.value
          ELSE json_set(
            charge.value,
            '$.conversationId',
            COALESCE(
              (
                SELECT stop.conversation_id
                FROM assistant_stops AS stop
                WHERE stop.voice_id = json_extract(charge.value, '$.id')
                ORDER BY stop.stopped_at ASC
                LIMIT 1
              ),
              (
                SELECT json_extract(task.value, '$.conversationId')
                FROM json_each(cleanup_row.data, '$.cleanup') AS task
                WHERE json_extract(task.value, '$.voiceUsage.chargeId') = json_extract(charge.value, '$.id')
                LIMIT 1
              ),
              (
                SELECT user.conversation_id
                FROM assistant_users AS user
                WHERE user.principal = cleanup_row.principal
                  AND user.voice_id = json_extract(charge.value, '$.id')
                  AND user.conversation_id IS NOT NULL
                LIMIT 1
              ),
              'legacy:' || json_extract(charge.value, '$.id')
            )
          )
        END
      ))
      FROM json_each(cleanup_row.data, '$.charges') AS charge
    ),
    '[]'
  ))
)
WHERE json_type(cleanup_row.data, '$.charges') = 'array'
  AND EXISTS(
    SELECT 1
    FROM json_each(cleanup_row.data, '$.charges') AS charge
    WHERE json_type(charge.value, '$.conversationId') IS NOT 'text'
  );
