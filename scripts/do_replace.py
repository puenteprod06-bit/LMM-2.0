with open('routes/orders.js','r',encoding='utf-8') as f:
    lines = f.readlines()

start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if 'VERIFICACI' in line:
        start_idx = i
    if start_idx is not None and 'hasShortage: stockResult.hasShortage' in line:
        end_idx = i
        break

print("start:", start_idx)
print("end:", end_idx)
"