with open('routes/orders.js','r',encoding='utf-8') as f:
    content = f.read()
target = "        const txShortages = checkStockShortages(safeItems);"
print("found txShortages line:", target in content)