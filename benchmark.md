# Benchmark Results

| Benchmark | Samples | Without Gateway p50 | Without Gateway p95 | Without Gateway p99 | With Gateway p50 | With Gateway p95 | With Gateway p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PII | 10 | 903.66 ms | 1415.88 ms | 1415.88 ms | 907.71 ms | 1420.23 ms | 1420.23 ms |
| Prompt injection | 10 | 1112.21 ms | 1267.62 ms | 1267.62 ms | 1240.36 ms | 1370.62 ms | 1370.62 ms |
| PII + prompt injection | 10 | 1140.71 ms | 1801.52 ms | 1801.52 ms | 1245.76 ms | 2008.70 ms | 2008.70 ms |
| Output JSON Schema | 10 | 1017.85 ms | 1144.36 ms | 1144.36 ms | 1023.85 ms | 1151.30 ms | 1151.30 ms |
