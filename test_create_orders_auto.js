const { BackpackClient } = require('./backpack_exchange-main/backpack_client');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 日志函数
function log(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    
    // 同时写入日志文件
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `trading_${date}.log`);
    
    fs.appendFileSync(
        logFile, 
        logMessage + '\n', 
        { encoding: 'utf8' }
    );
    
    // 如果是错误，写入专门的错误日志
    if (isError) {
        const errorLogFile = path.join(logDir, `error_${date}.log`);
        fs.appendFileSync(
            errorLogFile,
            logMessage + '\n',
            { encoding: 'utf8' }
        );
    }
}

// 读取配置文件
function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'backpack_trading_config.json');
        log(`加载配置文件: ${configPath}`);
        
        if (!fs.existsSync(configPath)) {
            throw new Error(`配置文件不存在: ${configPath}`);
        }
        
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);
        
        log(`配置文件加载成功`);
        return config;
    } catch (error) {
        log(`加载配置文件失败: ${error.message}`, true);
        throw error;
    }
}

// 全局用户配置
const userConfig = loadConfig();

// 配置参数 - 现在从配置文件中读取
const config = {
    // API配置
    privateKey: userConfig.api.privateKey,
    publicKey: userConfig.api.publicKey,
    
    // 交易配置
    pricePrecision: 2,        // 默认价格精度
    priceTickSize: userConfig.advanced.priceTickSize || 0.01,  // 价格最小变动单位
    minOrderAmount: userConfig.advanced.minOrderAmount || 10,  // 最小订单金额
    
    // 不同币种的数量精度配置
    quantityPrecisions: userConfig.quantityPrecisions || {
        'BTC': 5,     // BTC数量精度
        'ETH': 4,     // ETH数量精度
        'SOL': 2,     // SOL数量精度
        'DEFAULT': 2  // 其他币种默认数量精度
    },
    
    // 不同币种的价格精度配置
    pricePrecisions: userConfig.pricePrecisions || {
        'BTC': 0,     // BTC价格精度
        'ETH': 2,     // ETH价格精度
        'SOL': 2,     // SOL价格精度
        'DEFAULT': 2  // 其他币种默认价格精度
    },
    
    // 不同币种的最小交易量配置
    minQuantities: userConfig.minQuantities || {
        'BTC': 0.00001,   // BTC最小交易量
        'ETH': 0.001,     // ETH最小交易量
        'SOL': 0.01,      // SOL最小交易量
        'DEFAULT': 0.1    // 其他币种默认最小交易量
    },
    
    // 统计信息
    stats: {
        totalOrders: 0,
        filledOrders: 0,
        totalFilledAmount: 0,
        totalFilledQuantity: 0,
        averagePrice: 0,
        lastUpdateTime: null
    },
    
    // 已处理的订单ID集合
    processedOrderIds: new Set(),
    
    // 脚本启动时间
    scriptStartTime: new Date(),
    
    // 当前交易对
    symbol: null
};

// 创建readline接口 - 自动模式下实际上不需要，但保留以防止错误
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 读取用户输入的函数 - 自动模式下直接返回配置的值
async function question(prompt) {
    // 解析问题，返回对应的配置值
    if (prompt.includes('是否卖出所有非USDC资产')) {
        return userConfig.actions.sellNonUsdcAssets ? 'y' : 'n';
    } else if (prompt.includes('请输入交易币种')) {
        return userConfig.trading.tradingCoin;
    } else if (prompt.includes('是否撤销')) {
        return userConfig.actions.cancelAllOrders ? 'y' : 'n';
    } else if (prompt.includes('请输入最大跌幅百分比')) {
        return userConfig.trading.maxDropPercentage.toString();
    } else if (prompt.includes('请输入总投资金额')) {
        return userConfig.trading.totalAmount.toString();
    } else if (prompt.includes('请输入买入次数')) {
        return userConfig.trading.orderCount.toString();
    } else if (prompt.includes('请输入每次金额增加的百分比')) {
        return userConfig.trading.incrementPercentage.toString();
    } else if (prompt.includes('请输入止盈百分比')) {
        return userConfig.trading.takeProfitPercentage.toString();
    } else if (prompt.includes('是否继续创建订单')) {
        return 'y'; // 自动模式下始终确认
    } else {
        log(`未知的问题提示: ${prompt}，返回默认值'y'`);
        return 'y';
    }
}

// 执行API请求并重试
async function executeWithRetry(client, apiMethod, params, maxRetries = 3) {
    let retries = 0;
    let lastError = null;
    
    while (retries < maxRetries) {
        try {
            return await apiMethod.call(client, params);
        } catch (error) {
            lastError = error;
            
            // 详细记录错误信息
            log(`API请求失败 (${retries + 1}/${maxRetries}): ${error.message}`, true);
            
            // 如果有响应体，记录它
            if (error.response?.body) {
                log(`错误响应: ${JSON.stringify(error.response.body)}`, true);
            }
            
            // 如果还有重试机会，则等待后重试
            if (retries < maxRetries - 1) {
                const waitMs = 1000 * Math.pow(2, retries);
                log(`等待 ${waitMs}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            retries++;
        }
    }
    
    // 所有重试都失败了，抛出带有详细信息的错误
    throw new Error(`API请求失败，尝试了 ${maxRetries} 次: ${lastError?.message || '未知错误'}`);
}

// 调整数值精度
function adjustPrecision(value, precision) {
    const multiplier = Math.pow(10, precision);
    return Math.floor(value * multiplier) / multiplier;
}

// 调整价格到tickSize，并根据交易对的精度要求进行处理
function adjustPriceToTickSize(price, tradingCoin) {
    const tickSize = config.priceTickSize;
    // 获取该币种的价格精度
    const precision = config.pricePrecisions[tradingCoin] || config.pricePrecisions.DEFAULT;
    // 先向下取整到tickSize的倍数
    const adjustedPrice = Math.floor(price / tickSize) * tickSize;
    // 然后限制小数位数
    return Number(adjustedPrice.toFixed(precision));
}

// 调整数量到stepSize
function adjustQuantityToStepSize(quantity, tradingCoin) {
    const precision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
    const stepSize = Math.pow(10, -precision);
    const adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
    return Number(adjustedQuantity.toFixed(precision));
}

// 计算递增订单
function calculateIncrementalOrders(currentPrice, maxDropPercentage, totalAmount, orderCount, incrementPercentage, minOrderAmount, tradingCoin) {
    const orders = [];
    const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
    
    // 计算价格区间
    const lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
    const priceStep = (currentPrice - lowestPrice) / (orderCount - 1);
    
    // 计算基础订单金额（使用等比数列求和公式）
    // 总金额 = 基础金额 * (1 + r + r^2 + ... + r^(n-1))
    // 总金额 = 基础金额 * (1 - r^n) / (1 - r)
    // 基础金额 = 总金额 * (1 - r) / (1 - r^n)
    const r = 1 + incrementPercentage / 100; // 递增比例
    
    // 确保基础订单金额不小于最小订单金额
    const calculatedBaseAmount = totalAmount * (r - 1) / (Math.pow(r, orderCount) - 1);
    const baseAmount = Math.max(minOrderAmount, calculatedBaseAmount);
    
    // 计算实际总金额
    let actualTotalAmount = 0;
    for (let i = 0; i < orderCount; i++) {
        actualTotalAmount += baseAmount * Math.pow(r, i);
    }
    
    // 如果实际总金额超过用户输入的总金额，按比例缩小基础金额
    if (actualTotalAmount > totalAmount) {
        const scale = totalAmount / actualTotalAmount;
        actualTotalAmount = 0;
        
        // 创建订单
        for (let i = 0; i < orderCount; i++) {
            // 计算当前订单价格
            const price = Number((currentPrice - (priceStep * i)).toFixed(config.pricePrecision));
            
            // 计算当前订单金额（递增并缩放）
            const orderAmount = baseAmount * Math.pow(r, i) * scale;
            
            // 计算数量并调整精度
            const quantity = adjustQuantityToStepSize(orderAmount / price, tradingCoin);
            const actualAmount = Number((price * quantity).toFixed(2));
            
            // 只有当订单金额满足最小要求时才添加
            if (actualAmount >= minOrderAmount) {
                orders.push({
                    price,
                    quantity,
                    amount: actualAmount
                });
                actualTotalAmount += actualAmount;
            }
        }
    } else {
        // 创建订单
        for (let i = 0; i < orderCount; i++) {
            // 计算当前订单价格
            const price = Number((currentPrice - (priceStep * i)).toFixed(config.pricePrecision));
            
            // 计算当前订单金额（递增）
            const orderAmount = baseAmount * Math.pow(r, i);
            
            // 计算数量并调整精度
            const quantity = adjustQuantityToStepSize(orderAmount / price, tradingCoin);
            const actualAmount = Number((price * quantity).toFixed(2));
            
            // 只有当订单金额满足最小要求时才添加
            if (actualAmount >= minOrderAmount) {
                orders.push({
                    price,
                    quantity,
                    amount: actualAmount
                });
                actualTotalAmount += actualAmount;
            }
        }
    }
    
    // 如果没有生成任何订单，抛出错误
    if (orders.length === 0) {
        throw new Error('无法生成有效订单，请检查输入参数');
    }
    
    log(`计划总金额: ${totalAmount.toFixed(2)} USDC`);
    log(`实际总金额: ${actualTotalAmount.toFixed(2)} USDC`);
    
    return orders;
}

// 撤销所有未完成的订单
async function cancelAllOrders(client) {
    try {
        log('正在获取未完成订单...');
        // 使用client.getOpenOrders方法获取未完成订单
        const openOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol: config.symbol });
        
        if (!openOrders || openOrders.length === 0) {
            log('没有未完成的订单需要撤销');
            return;
        }
        
        // 过滤出买入订单
        const activeBuyOrders = openOrders.filter(order => order.side === 'Bid') || [];
        
        if (activeBuyOrders.length === 0) {
            log('没有未完成的买入订单需要撤销');
            return;
        }
        
        log(`发现 ${activeBuyOrders.length} 个未完成买入订单，开始撤销...`);
        log(`首个订单详情: ${JSON.stringify(activeBuyOrders[0])}`);
        
        // 尝试方法1: 使用CancelOpenOrders方法（这是backpack_client.js中实际存在的方法）
        try {
            log('尝试使用CancelOpenOrders方法撤销所有订单...');
            await executeWithRetry(client, client.CancelOpenOrders, { symbol: config.symbol });
            log('成功使用CancelOpenOrders撤销所有订单');
            return;
        } catch (error1) {
            log(`使用CancelOpenOrders方法撤销失败: ${error1.message}，尝试下一种方法`, true);
        }
        
        // 尝试方法2: 直接调用API端点而不是CancelAllOrders
        try {
            log('尝试使用privateMethod直接调用orderCancelAll端点...');
            await client.privateMethod('orderCancelAll', { symbol: config.symbol });
            log('成功通过privateMethod撤销所有订单');
            return;
        } catch (error2) {
            log(`使用privateMethod撤销失败: ${error2.message}，尝试逐个撤销`, true);
        }
        
        // 如果批量撤销方法都失败，则尝试逐个撤销
        for (const order of activeBuyOrders) {
            try {
                // 记录完整订单信息，用于调试
                log(`处理订单: ${JSON.stringify(order)}`);
                
                // 尝试不同格式的订单ID
                const orderId = order.id || order.orderId || order.order_id;
                if (!orderId) {
                    log('找不到有效的订单ID，跳过', true);
                    continue;
                }
                
                // 提取订单ID（数字和字符串形式）
                const orderIdNumber = Number(orderId);
                const orderIdString = String(orderId);
                
                // 记录将要使用的订单ID值
                log(`将使用订单ID: ${orderId} (数字形式: ${orderIdNumber}, 字符串形式: ${orderIdString})`);
                
                // 尝试方法1: 直接使用私有方法
                try {
                    log(`尝试使用privateMethod直接调用orderCancel...`);
                    await client.privateMethod('orderCancel', {
                        symbol: config.symbol,
                        orderId: orderIdNumber
                    });
                    log(`成功使用privateMethod撤销订单ID: ${orderId}`);
                    continue;
                } catch (error3) {
                    log(`使用privateMethod撤销失败: ${error3.message}`, true);
                }
                
                // 尝试方法2: 使用CancelOrder
                try {
                    log(`尝试使用CancelOrder和数字型ID撤销订单...`);
                    await executeWithRetry(client, client.CancelOrder, {
                        symbol: config.symbol,
                        orderId: orderIdNumber
                    });
                    log(`成功使用CancelOrder撤销订单ID: ${orderId}`);
                    continue;
                } catch (error4) {
                    log(`使用CancelOrder和数字型ID撤销失败: ${error4.message}`, true);
                }
                
                // 尝试字符串类型ID
                try {
                    log(`尝试使用CancelOrder和字符串型ID撤销订单...`);
                    await executeWithRetry(client, client.CancelOrder, {
                        symbol: config.symbol,
                        orderId: orderIdString
                    });
                    log(`成功使用CancelOrder和字符串ID撤销订单ID: ${orderId}`);
                    continue;
                } catch (error5) {
                    log(`使用CancelOrder和字符串ID撤销失败: ${error5.message}`, true);
                }
                
                // 尝试使用取消多个订单的API
                try {
                    log(`尝试使用privateMethod和orderIds数组...`);
                    await client.privateMethod('orderCancel', {
                        symbol: config.symbol,
                        orderIds: [orderIdString]
                    });
                    log(`成功使用privateMethod和orderIds数组撤销订单ID: ${orderId}`);
                    continue;
                } catch (error6) {
                    log(`使用privateMethod和orderIds数组撤销失败: ${error6.message}`, true);
                }
                
                // 所有尝试都失败了
                log(`无法撤销订单ID: ${orderId}，尝试了所有可能的方法都失败`, true);
                
            } catch (cancelError) {
                log(`撤销订单时发生错误: ${cancelError.message}`, true);
                if (cancelError.response?.body) {
                    log(`撤销订单错误详情: ${JSON.stringify(cancelError.response.body)}`, true);
                }
            }
            
            // 添加延迟避免API限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        log('所有订单撤销操作完成或已尝试');
    } catch (error) {
        log(`撤销订单时发生错误: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        // 继续执行，不抛出错误
    }
}

// 创建买入订单
async function createBuyOrder(client, symbol, price, quantity, tradingCoin) {
    try {
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        
        // 调整价格的精度
        const adjustedPrice = adjustPriceToTickSize(price, tradingCoin);
        
        const orderParams = {
            symbol: symbol,
            side: 'Bid',           // 买入
            orderType: 'Limit',    // 限价单
            price: adjustedPrice.toString(),  // 使用已调整的价格
            quantity: quantity.toFixed(quantityPrecision),
            timeInForce: 'GTC'     // Good Till Cancel
        };
        
        // 特殊处理BTC
        if (tradingCoin === 'BTC') {
            log('BTC交易检测，额外调整精度...');
            // 检查数量精度
            const btcQuantityStr = orderParams.quantity;
            if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                orderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                log(`调整BTC数量精度为5位小数: ${orderParams.quantity}`);
            }
            
            // 确保价格是整数
            orderParams.price = Math.floor(parseFloat(orderParams.price)).toString();
            log(`调整BTC价格为整数: ${orderParams.price}`);
        }
        
        log(`发送订单参数: ${JSON.stringify(orderParams)}`);
        
        const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
        log(`API响应: ${JSON.stringify(response)}`);
        
        if (response && response.id) {
            log(`买入订单创建成功: 订单ID=${response.id}`);
            
            // 计算并添加订单金额信息，确保有数据可以统计
            if (!response.filledAmount && response.price && response.quantity) {
                response.filledAmount = (parseFloat(response.price) * parseFloat(response.quantity)).toString();
                response.filledQuantity = response.quantity;
            }
            
            updateStats(response);
            return response;
        } else {
            throw new Error('订单创建失败：响应中没有订单ID');
        }
    } catch (error) {
        log(`创建买入订单失败: ${error.message}`, true);
        if (error.response) {
            log(`API响应状态码: ${error.response.statusCode}`, true);
            log(`API响应体: ${JSON.stringify(error.response.body)}`, true);
        }
        throw error;
    }
}

// 更新统计信息
function updateStats(order) {
    config.stats.totalOrders++;
    
    // 确保有成交信息再更新成交统计
    if (order.status === 'Filled' || order.status === 'PartiallyFilled') {
        // 确保使用数字类型进行计算
        const filledAmount = parseFloat(order.filledAmount || 0);
        const filledQuantity = parseFloat(order.filledQuantity || 0);
        
        // 检查是否已处理过这个订单ID
        if (!config.processedOrderIds.has(order.id)) {
            config.processedOrderIds.add(order.id);
            
            if (!isNaN(filledAmount) && filledAmount > 0) {
                config.stats.totalFilledAmount += filledAmount;
            }
            
            if (!isNaN(filledQuantity) && filledQuantity > 0) {
                config.stats.totalFilledQuantity += filledQuantity;
                config.stats.filledOrders++;
            }
            
            // 只有当有效成交量存在时才计算均价
            if (config.stats.totalFilledQuantity > 0) {
                config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
            }
            
            log(`更新统计: 成交订单=${config.stats.filledOrders}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 均价=${config.stats.averagePrice.toFixed(2)}`);
        } else {
            log(`跳过已统计过的订单ID: ${order.id}`);
        }
    }
    
    config.stats.lastUpdateTime = new Date();
    
    // 更新交易周期统计
    updateCycleStats(order, config);
    
    // 记录订单信息到周期日志
    if (cycleLogFile) {
        logOrderToCycle(cycleLogFile, order, config);
    }
}

// 显示统计信息
function displayStats() {
    log('\n=== 订单统计信息 ===');
    log(`总挂单次数: ${config.stats.totalOrders}`);
    log(`已成交订单: ${config.stats.filledOrders}`);
    log(`总成交金额: ${config.stats.totalFilledAmount.toFixed(2)} USDC`);
    log(`总成交数量: ${config.stats.totalFilledQuantity.toFixed(6)}`);
    log(`平均成交价格: ${config.stats.averagePrice.toFixed(2)} USDC`);
    log(`最后更新时间: ${config.stats.lastUpdateTime ? config.stats.lastUpdateTime.toLocaleString() : '无'}`);
    log('==================\n');
}

// 查询持仓信息
async function getPosition(client, symbol) {
    try {
        // 使用Balance API获取持仓信息
        const balances = await executeWithRetry(client, client.Balance);
        
        if (!balances) {
            return null;
        }

        // 从symbol中提取币种（例如：从"BTC_USDC"中提取"BTC"）
        const coin = symbol.split('_')[0];
        
        // 查找对应币种的余额
        if (!balances[coin] || parseFloat(balances[coin].available) <= 0) {
            return null;
        }

        // 构造持仓信息
        return {
            quantity: balances[coin].available,
            asset: coin,
            total: (parseFloat(balances[coin].available) + parseFloat(balances[coin].locked)).toString(),
            available: balances[coin].available
        };
    } catch (error) {
        log(`查询持仓失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return null;
    }
}

// 查询订单历史并更新统计
async function queryOrdersAndUpdateStats(client, symbol) {
    try {
        log('查询当前交易周期新成交的订单...');
        
        // 保存当前的统计数据，防止查询过程覆盖已有数据
        const currentStats = {
            filledOrders: config.stats.filledOrders,
            totalFilledAmount: config.stats.totalFilledAmount,
            totalFilledQuantity: config.stats.totalFilledQuantity,
            averagePrice: config.stats.averagePrice
        };
        
        // 使用正确的API方法获取订单历史
        let orders = [];
        try {
            // 直接使用privateMethod调用orderHistoryQueryAll，不尝试GetOrderHistory
            log('使用privateMethod调用orderHistoryQueryAll获取订单历史...');
            orders = await client.privateMethod('orderHistoryQueryAll', { symbol });
        } catch (error) {
            log(`privateMethod调用失败: ${error.message}，尝试其他方法`, true);
            
            try {
                log('尝试使用GetOpenOrders获取未完成订单...');
                const openOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol });
                if (openOrders && openOrders.length > 0) {
                    log(`获取到 ${openOrders.length} 个未完成订单`);
                    orders = openOrders;
                }
            } catch (error2) {
                log(`GetOpenOrders方法也失败: ${error2.message}`, true);
                
                // 如果所有方法都失败，保留当前统计并返回
                log('无法获取订单历史，保留当前统计数据');
                return currentStats.filledOrders > 0;
            }
        }
        
        if (!orders || orders.length === 0) {
            log('未查询到任何订单历史，保留当前统计数据');
            return currentStats.filledOrders > 0;
        }
        
        log(`成功获取到 ${orders.length} 个订单`);
        
        // 只查找本次脚本启动后创建并成交的买入订单
        const recentFilledBuyOrders = orders.filter(order => {
            // 检查订单是否已成交或部分成交，且是买入订单
            const isBuyOrder = order.side === 'Bid';
            const isFilledOrder = order.status === 'Filled' || order.status === 'PartiallyFilled';
            
            // 检查订单创建时间是否在脚本启动后
            let isRecentOrder = false;
            if (order.createTime) {
                const createTime = new Date(order.createTime);
                isRecentOrder = createTime >= config.scriptStartTime;
            } else if (order.timestamp) {
                const createTime = new Date(order.timestamp);
                isRecentOrder = createTime >= config.scriptStartTime;
            }
            
            // 检查是否已经处理过这个订单
            const isProcessed = config.processedOrderIds.has(order.id);
            
            if (isProcessed && isFilledOrder && isBuyOrder) {
                log(`跳过已处理的订单: ID=${order.id}`);
                return false;
            }
            
            // 只处理在本次脚本启动后创建的订单
            return isBuyOrder && isFilledOrder && isRecentOrder && !isProcessed;
        });
        
        log(`筛选出 ${recentFilledBuyOrders.length} 个本次交易周期中新成交的买入订单`);
        
        // 添加新成交的订单到统计
        for (const order of recentFilledBuyOrders) {
            const filledAmount = parseFloat(order.filledAmount || 0);
            const filledQuantity = parseFloat(order.filledQuantity || 0);
            
            log(`处理新成交订单: ID=${order.id}, 成交金额=${filledAmount}, 成交数量=${filledQuantity}`);
            
            // 将订单ID添加到已处理集合
            config.processedOrderIds.add(order.id);
            
            if (!isNaN(filledAmount) && filledAmount > 0) {
                config.stats.totalFilledAmount += filledAmount;
            }
            
            if (!isNaN(filledQuantity) && filledQuantity > 0) {
                config.stats.totalFilledQuantity += filledQuantity;
                config.stats.filledOrders++;
            }
        }
        
        // 计算实际均价 - 只有当我们有成交数据时才计算
        if (config.stats.totalFilledQuantity > 0) {
            config.stats.averagePrice = config.stats.totalFilledAmount / config.stats.totalFilledQuantity;
            log(`更新后的统计: 成交订单=${config.stats.filledOrders}, 成交金额=${config.stats.totalFilledAmount.toFixed(2)}, 成交数量=${config.stats.totalFilledQuantity.toFixed(6)}, 均价=${config.stats.averagePrice.toFixed(2)}`);
            return true;
        } else {
            // 如果没有成交数据但之前统计过，则保留之前的统计
            if (currentStats.filledOrders > 0) {
                log('没有找到新的成交订单，保留之前的统计数据');
                return true;
            } else {
                log('没有找到任何成交的买入订单，无法计算实际均价');
                return false;
            }
        }
    } catch (error) {
        log(`查询订单历史失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return false;
    }
}

// 检查止盈条件
async function checkTakeProfit(client, symbol, tradingCoin, takeProfitPercentage) {
    try {
        // 首先检查是否有持仓
        const position = await getPosition(client, symbol);
        if (!position || parseFloat(position.quantity) <= 0) {
            log('当前没有持仓，不检查止盈条件');
            return false;
        }

        // 获取当前市场价格
        const ticker = await executeWithRetry(client, client.Ticker, { symbol: symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        
        // 检查我们是否有实际成交订单的均价数据
        if (isNaN(config.stats.averagePrice) || config.stats.averagePrice <= 0 || config.stats.filledOrders === 0) {
            // 尝试更新均价（只查找本次脚本启动后的订单）
            const statsUpdated = await queryOrdersAndUpdateStats(client, symbol);
            
            if (!statsUpdated || isNaN(config.stats.averagePrice) || config.stats.averagePrice <= 0 || config.stats.filledOrders === 0) {
                // 没有实际成交的买入订单，继续监控但不触发止盈
                log('当前没有实际成交的买入订单，无法计算涨幅，继续监控...');
                log(`当前持仓: ${position.quantity} ${tradingCoin}, 当前价格: ${currentPrice.toFixed(2)} USDC`);
                return false;
            }
        }
        
        // 计算价格涨幅百分比
        const priceIncrease = ((currentPrice - config.stats.averagePrice) / config.stats.averagePrice) * 100;
        const formattedIncrease = priceIncrease.toFixed(2);
        
        // 详细记录当前情况
        log(`止盈检查: 当前价格=${currentPrice.toFixed(2)} USDC, 实际成交均价=${config.stats.averagePrice.toFixed(2)} USDC, 涨幅=${formattedIncrease}%, 目标=${takeProfitPercentage}%`);
        
        // 判断是否达到止盈条件
        const reachedTakeProfit = priceIncrease >= takeProfitPercentage;
        
        if (reachedTakeProfit) {
            log(`***** 达到止盈条件！当前涨幅 ${formattedIncrease}% 已超过目标 ${takeProfitPercentage}% *****`);
        }
        
        return reachedTakeProfit;
    } catch (error) {
        log(`检查止盈条件失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return false;
    }
}

// 市价卖出所有持仓（改为限价单）
async function sellAllPosition(client, symbol, tradingCoin) {
    try {
        // 获取当前持仓情况
        const position = await getPosition(client, symbol);
        if (!position || parseFloat(position.quantity) <= 0) {
            log('没有可卖出的持仓');
            return null;
        }

        // 获取数量精度
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        
        // 调整数量精度
        const quantity = adjustQuantityToStepSize(parseFloat(position.quantity), tradingCoin);
        if (quantity <= 0) {
            log('可卖出数量太小，无法执行卖出操作');
            return null;
        }

        // 获取当前市场价格以设置限价
        const ticker = await executeWithRetry(client, client.Ticker, { symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        
        // 设置卖出价格略低于市场价（确保能够成交），使用正确的价格精度
        const sellPrice = adjustPriceToTickSize(currentPrice * 0.995, tradingCoin);
        
        log(`准备卖出: ${quantity} ${tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);

        // 创建限价卖出订单参数
        const orderParams = {
            symbol: symbol,
            side: 'Ask',           // 卖出
            orderType: 'Limit',    // 限价单
            quantity: quantity.toFixed(quantityPrecision),
            price: sellPrice.toString(),  // 使用toString避免可能的自动四舍五入
            timeInForce: 'IOC'     // Immediate-or-Cancel
        };

        // 特殊处理BTC
        if (tradingCoin === 'BTC') {
            log('BTC交易检测，额外调整精度...');
            // 检查数量精度
            const btcQuantityStr = orderParams.quantity;
            if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                orderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                log(`调整BTC数量精度为5位小数: ${orderParams.quantity}`);
            }
            
            // 确保价格是整数
            orderParams.price = Math.floor(parseFloat(orderParams.price)).toString();
            log(`调整BTC价格为整数: ${orderParams.price}`);
        }

        log(`发送限价卖出订单: ${JSON.stringify(orderParams)}`);
        const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
        
        if (response && response.id) {
            log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
            
            // 检查订单是否完全成交
            let fullyFilled = response.status === 'Filled';
            
            // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
            if (!fullyFilled) {
                log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
                
                // 等待一小段时间，让订单有时间处理
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // 获取更新后的持仓
                const updatedPosition = await getPosition(client, symbol);
                if (updatedPosition && parseFloat(updatedPosition.quantity) > 0) {
                    const remainingQuantity = adjustQuantityToStepSize(parseFloat(updatedPosition.quantity), tradingCoin);
                    
                    log(`仍有 ${remainingQuantity} ${tradingCoin} 未售出，尝试以更低价格卖出`);
                    
                    // 更低的价格再次尝试 (原价格的99%)，使用正确的价格精度
                    const lowerSellPrice = adjustPriceToTickSize(currentPrice * 0.99, tradingCoin);
                    
                    const remainingOrderParams = {
                        symbol: symbol,
                        side: 'Ask',
                        orderType: 'Limit',
                        quantity: remainingQuantity.toFixed(quantityPrecision),
                        price: lowerSellPrice.toString(),
                        timeInForce: 'IOC'
                    };
                    
                    // 特殊处理BTC
                    if (tradingCoin === 'BTC') {
                        // 检查数量精度
                        const btcQuantityStr = remainingOrderParams.quantity;
                        if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                            remainingOrderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                            log(`调整BTC数量精度为5位小数: ${remainingOrderParams.quantity}`);
                        }
                        
                        // 确保价格是整数
                        remainingOrderParams.price = Math.floor(parseFloat(remainingOrderParams.price)).toString();
                        log(`调整BTC价格为整数: ${remainingOrderParams.price}`);
                    }
                    
                    log(`发送更低价格的限价卖出订单: ${JSON.stringify(remainingOrderParams)}`);
                    const secondResponse = await executeWithRetry(client, client.ExecuteOrder, remainingOrderParams);
                    
                    if (secondResponse && secondResponse.id) {
                        log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
                        fullyFilled = secondResponse.status === 'Filled';
                    } else {
                        log('第二次卖出订单创建失败');
                    }
                    
                    // 再次检查是否还有剩余
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const finalPosition = await getPosition(client, symbol);
                    if (finalPosition && parseFloat(finalPosition.quantity) > 0) {
                        log(`警告: 仍有 ${finalPosition.quantity} ${tradingCoin} 未能售出`);
                    } else {
                        log(`所有 ${tradingCoin} 已售出`);
                        fullyFilled = true;
                    }
                } else {
                    log(`所有 ${tradingCoin} 已售出`);
                    fullyFilled = true;
                }
            }
            
            log(`卖出操作完成，交易${fullyFilled ? '全部' : '部分'}成交`);
            return response;
        } else {
            throw new Error('卖出订单创建失败：响应中没有订单ID');
        }
    } catch (error) {
        log(`卖出失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return null;
    }
}

// 查询账户所有余额信息
async function getAllBalances(client) {
    try {
        // 使用Balance API获取余额信息
        const balances = await executeWithRetry(client, client.Balance);
        
        if (!balances) {
            return [];
        }

        // 过滤掉余额为0的币种
        const nonZeroBalances = Object.entries(balances)
            .filter(([_, balance]) => 
                parseFloat(balance.available) > 0 || 
                parseFloat(balance.locked) > 0 || 
                parseFloat(balance.staked || '0') > 0
            )
            .map(([currency, balance]) => ({
                asset: currency,
                total: (parseFloat(balance.available) + parseFloat(balance.locked) + parseFloat(balance.staked || '0')).toString(),
                available: balance.available,
                locked: balance.locked,
                staked: balance.staked || '0'
            }));

        return nonZeroBalances;
    } catch (error) {
        log(`查询账户余额失败: ${error.message}`, true);
        if (error.response?.body) {
            log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
        }
        return [];
    }
}

// 显示账户余额信息
async function displayBalances(client) {
    try {
        log('\n=== 账户余额信息 ===');
        const balances = await getAllBalances(client);
        
        if (balances && balances.length > 0) {
            // 获取USDC价格信息，用于计算其他币种的价值
            let usdcPrices = {};
            for (const balance of balances) {
                if (balance.asset !== 'USDC') {
                    try {
                        const symbol = `${balance.asset}_USDC`;
                        const ticker = await executeWithRetry(client, client.Ticker, { symbol });
                        usdcPrices[balance.asset] = parseFloat(ticker.lastPrice);
                    } catch (error) {
                        log(`获取${balance.asset}价格失败: ${error.message}`, true);
                        usdcPrices[balance.asset] = 0;
                    }
                }
            }
            
            let totalUsdcValue = 0;
            log('币种\t总余额\t可用余额\t冻结余额\t估计价值(USDC)');
            log('----------------------------------------------------------');
            
            for (const balance of balances) {
                const total = parseFloat(balance.total);
                const available = parseFloat(balance.available);
                const locked = parseFloat(balance.locked);
                
                let usdcValue = 0;
                if (balance.asset === 'USDC') {
                    usdcValue = total;
                } else if (usdcPrices[balance.asset]) {
                    usdcValue = total * usdcPrices[balance.asset];
                }
                
                totalUsdcValue += usdcValue;
                
                log(`${balance.asset}\t${total.toFixed(6)}\t${available.toFixed(6)}\t${locked.toFixed(6)}\t${usdcValue.toFixed(2)}`);
            }
            
            log('----------------------------------------------------------');
            log(`总价值: ${totalUsdcValue.toFixed(2)} USDC`);
            return balances;
        } else {
            log('未找到任何币种的余额信息');
            return [];
        }
    } catch (error) {
        log(`显示账户余额失败: ${error.message}`, true);
        return [];
    }
}

// 卖出所有非USDC币种
async function sellAllNonUsdcAssets(client, minValueRequired = 10) {
    try {
        log('\n=== 卖出所有非USDC币种 ===');
        const balances = await getAllBalances(client);
        
        if (!balances || balances.length === 0) {
            log('没有找到任何余额信息');
            return;
        }
        
        const nonUsdcBalances = balances.filter(b => b.asset !== 'USDC' && parseFloat(b.available) > 0);
        if (nonUsdcBalances.length === 0) {
            log('没有可供卖出的非USDC币种');
            return;
        }
        
        // 首先筛选出价值大于等于minValueRequired的币种
        const valuableBalances = [];
        for (const balance of nonUsdcBalances) {
            try {
                // 获取当前市场价格
                const symbol = `${balance.asset}_USDC`;
                let ticker;
                try {
                    ticker = await executeWithRetry(client, client.Ticker, { symbol });
                } catch (error) {
                    log(`获取 ${symbol} 价格失败，跳过此币种: ${error.message}`, true);
                    continue;
                }
                
                const currentPrice = parseFloat(ticker.lastPrice);
                const available = parseFloat(balance.available);
                const assetValue = available * currentPrice;
                
                log(`${balance.asset}: 可用余额=${available}, 当前价格=${currentPrice} USDC, 价值=${assetValue.toFixed(2)} USDC`);
                
                // 如果价值小于最小要求，则跳过
                if (assetValue < minValueRequired) {
                    log(`${balance.asset} 价值小于 ${minValueRequired} USDC，跳过卖出`);
                    continue;
                }
                
                valuableBalances.push({
                    ...balance,
                    currentPrice,
                    value: assetValue
                });
            } catch (error) {
                log(`检查 ${balance.asset} 价值时出错: ${error.message}`, true);
            }
        }
        
        if (valuableBalances.length === 0) {
            log(`没有价值大于等于 ${minValueRequired} USDC 的非USDC币种，跳过卖出`);
            return;
        }
        
        log(`发现 ${valuableBalances.length} 个价值大于等于 ${minValueRequired} USDC 的非USDC币种可供卖出`);
        
        for (const balance of valuableBalances) {
            try {
                // 获取该币种的数量精度
                const quantityPrecision = config.quantityPrecisions[balance.asset] || config.quantityPrecisions.DEFAULT;
                
                // 调整数量精度
                const quantity = adjustQuantityToStepSize(parseFloat(balance.available), balance.asset);
                
                // 检查是否有足够的数量
                if (quantity <= 0) {
                    log(`${balance.asset}: 调整精度后数量为零，跳过卖出`);
                    continue;
                }
                
                // 使用正确的价格精度
                const sellPrice = adjustPriceToTickSize(balance.currentPrice * 0.995, balance.asset);
                
                log(`${balance.asset}: 准备卖出数量=${quantity}, 调整后价格=${sellPrice} USDC`);
                
                // 创建限价卖出订单，确保价格和数量精度正确
                const orderParams = {
                    symbol: `${balance.asset}_USDC`,
                    side: 'Ask',           // 卖出
                    orderType: 'Limit',    // 限价单
                    quantity: quantity.toFixed(quantityPrecision),
                    price: sellPrice.toString(),  // 使用toString而不是toFixed，避免自动四舍五入
                    timeInForce: 'IOC'     // Immediate-or-Cancel
                };
                
                // 特殊处理BTC
                if (balance.asset === 'BTC') {
                    log('BTC交易检测，额外调整精度...');
                    // 检查数量精度
                    const btcQuantityStr = orderParams.quantity;
                    if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                        orderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                        log(`调整BTC数量精度为5位小数: ${orderParams.quantity}`);
                    }
                    
                    // 确保价格是整数
                    orderParams.price = Math.floor(parseFloat(orderParams.price)).toString();
                    log(`调整BTC价格为整数: ${orderParams.price}`);
                }
                
                log(`发送限价卖出订单: ${JSON.stringify(orderParams)}`);
                
                const response = await executeWithRetry(client, client.ExecuteOrder, orderParams);
                
                if (response && response.id) {
                    log(`卖出 ${balance.asset} 成功: 订单ID=${response.id}, 状态=${response.status || '未知'}`);
                    
                    // 检查是否完全成交
                    if (response.status !== 'Filled') {
                        log(`订单未完全成交，尝试以更低价格卖出剩余部分`);
                        
                        // 等待一小段时间
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // 检查剩余余额
                        const updatedBalances = await getAllBalances(client);
                        const updatedBalance = updatedBalances.find(b => b.asset === balance.asset);
                        
                        if (updatedBalance && parseFloat(updatedBalance.available) > 0) {
                            // 调整数量精度
                            const remainingQuantity = adjustQuantityToStepSize(parseFloat(updatedBalance.available), balance.asset);
                            
                            if (remainingQuantity > 0) {
                                log(`仍有 ${remainingQuantity} ${balance.asset} 未卖出，尝试更低价格`);
                                
                                // 使用更低的价格重试
                                const lowerSellPrice = adjustPriceToTickSize(balance.currentPrice * 0.99, balance.asset);
                                
                                const retryOrderParams = {
                                    symbol: `${balance.asset}_USDC`,
                                    side: 'Ask',
                                    orderType: 'Limit',
                                    quantity: remainingQuantity.toFixed(quantityPrecision),
                                    price: lowerSellPrice.toString(),
                                    timeInForce: 'IOC'
                                };
                                
                                // 特殊处理BTC
                                if (balance.asset === 'BTC') {
                                    // 检查数量精度
                                    const btcQuantityStr = retryOrderParams.quantity;
                                    if (btcQuantityStr.split('.')[1] && btcQuantityStr.split('.')[1].length > 5) {
                                        retryOrderParams.quantity = parseFloat(btcQuantityStr).toFixed(5);
                                        log(`调整BTC数量精度为5位小数: ${retryOrderParams.quantity}`);
                                    }
                                    
                                    // 确保价格是整数
                                    retryOrderParams.price = Math.floor(parseFloat(retryOrderParams.price)).toString();
                                    log(`调整BTC价格为整数: ${retryOrderParams.price}`);
                                }
                                
                                log(`发送更低价格的限价卖出订单: ${JSON.stringify(retryOrderParams)}`);
                                const retryResponse = await executeWithRetry(client, client.ExecuteOrder, retryOrderParams);
                                
                                if (retryResponse && retryResponse.id) {
                                    log(`第二次卖出 ${balance.asset} 成功: 订单ID=${retryResponse.id}`);
                                } else {
                                    log(`第二次卖出 ${balance.asset} 失败`);
                                }
                            }
                        } else {
                            log(`所有 ${balance.asset} 已售出或无法获取最新余额`);
                        }
                    }
                } else {
                    log(`卖出 ${balance.asset} 失败: 响应中没有订单ID`);
                }
                
                // 添加延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                log(`卖出 ${balance.asset} 失败: ${error.message}`, true);
                if (error.response?.body) {
                    log(`错误详情: ${JSON.stringify(error.response.body)}`, true);
                }
                // 继续处理其他币种，不中断流程
            }
        }
        
        log('所有非USDC币种卖出操作完成');
        
    } catch (error) {
        log(`卖出所有非USDC币种失败: ${error.message}`, true);
    }
}

// 主函数 - 现在变成一个可以循环运行的函数
async function main() {
    try {
        log('=== Backpack 自动化递增买入系统启动 ===');
        log(`脚本启动时间: ${config.scriptStartTime.toISOString()}`);
        
        // 每次运行开始时重新加载配置
        const updatedConfig = loadConfig();
        // 将最新配置合并到当前配置中
        Object.assign(userConfig, updatedConfig);
        
        log('最新配置已加载');
        
        // 初始化客户端
        const client = new BackpackClient(config.privateKey, config.publicKey);
        log('API客户端初始化成功');
        
        // 显示账户余额
        await displayBalances(client);
        
        // 查询是否要卖出所有非USDC资产
        const sellConfirm = await question('\n是否卖出所有非USDC资产? (y/n): ');
        if (sellConfirm.toLowerCase() === 'y') {
            await sellAllNonUsdcAssets(client, userConfig.advanced.sellNonUsdcMinValue || 10);
            // 再次显示账户余额，确认卖出结果
            log('\n卖出后余额:');
            await displayBalances(client);
        }
        
        // 获取交易币种
        const tradingCoin = await question('请输入交易币种 (例如: BTC, SOL): ');
        const symbol = `${tradingCoin}_USDC`;
        log(`选择的交易对: ${symbol}`);
        
        // 保存交易币对到全局配置，方便其他函数使用
        config.symbol = symbol;
        
        // 询问是否撤销该交易对的所有未完成订单
        const cancelConfirm = await question(`\n是否撤销 ${symbol} 交易对的所有未完成订单? (y/n): `);
        if (cancelConfirm.toLowerCase() === 'y') {
            log(`开始撤销 ${symbol} 交易对的所有未完成订单...`);
            await cancelAllOrders(client);
        }
        
        // 获取当前市场价格
        const ticker = await executeWithRetry(client, client.Ticker, { symbol: symbol });
        const currentPrice = parseFloat(ticker.lastPrice);
        log(`当前市场价格: ${currentPrice} USDC`);
        
        // 根据币种获取最小交易量和数量精度
        const minQuantity = config.minQuantities[tradingCoin] || config.minQuantities.DEFAULT;
        const quantityPrecision = config.quantityPrecisions[tradingCoin] || config.quantityPrecisions.DEFAULT;
        log(`最小交易量: ${minQuantity} ${tradingCoin}`);
        log(`数量精度: ${quantityPrecision} 位小数`);
        
        // 根据当前价格动态调整最小订单金额
        const minOrderAmount = Math.max(config.minOrderAmount, currentPrice * minQuantity);
        log(`当前最小订单金额: ${minOrderAmount.toFixed(2)} USDC`);
        
        // 获取交易参数
        const maxDropPercentage = parseFloat(await question('请输入最大跌幅百分比 (例如: 5): '));
        const totalAmount = parseFloat(await question('请输入总投资金额 (USDC): '));
        const orderCount = parseInt(await question('请输入买入次数: '));
        const incrementPercentage = parseFloat(await question('请输入每次金额增加的百分比 (例如: 10): '));
        const takeProfitPercentage = parseFloat(await question('请输入止盈百分比 (例如: 5): '));
        
        // 验证输入
        if (totalAmount < minOrderAmount * orderCount) {
            throw new Error(`总投资金额太小，无法创建 ${orderCount} 个订单（每个订单最小金额: ${minOrderAmount.toFixed(2)} USDC）`);
        }
        
        // 计算订单
        const orders = calculateIncrementalOrders(
            currentPrice,
            maxDropPercentage,
            totalAmount,
            orderCount,
            incrementPercentage,
            minOrderAmount,
            tradingCoin
        );
        
        // 显示计划创建的订单
        log('\n=== 计划创建的订单 ===');
        let totalOrderAmount = 0;
        orders.forEach((order, index) => {
            log(`订单 ${index + 1}: 价格=${order.price} USDC, 数量=${order.quantity} ${tradingCoin}, 金额=${order.amount} USDC`);
            totalOrderAmount += order.amount;
        });
        log(`总订单金额: ${totalOrderAmount.toFixed(2)} USDC`);
        
        // 确认是否继续
        const confirm = await question('\n是否继续创建订单? (y/n): ');
        if (confirm.toLowerCase() !== 'y') {
            log('用户取消操作');
            return false; // 返回false表示不需要重启
        }
        
        // 创建订单
        log('\n=== 开始创建订单 ===');
        let successCount = 0;
        
        // 重置统计信息以确保干净的数据
        config.stats = {
            totalOrders: 0,
            filledOrders: 0,
            totalFilledAmount: 0,
            totalFilledQuantity: 0,
            averagePrice: 0,
            lastUpdateTime: null
        };
        
        // 清空已处理订单ID集合
        config.processedOrderIds = new Set();
        
        for (const order of orders) {
            try {
                const response = await createBuyOrder(client, symbol, order.price, order.quantity, tradingCoin);
                successCount++;
                
                // 添加延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                log(`创建订单失败: ${error.message}`, true);
                // 如果是资金不足，跳过后续订单
                if (error.message.includes('Insufficient') || error.message.includes('insufficient')) {
                    log('资金不足，停止创建更多订单', true);
                    break;
                }
            }
        }
        
        // 查询所有订单并更新统计信息，确保均价计算准确
        await queryOrdersAndUpdateStats(client, symbol);
        
        // 显示统计信息
        displayStats();
        
        // 开始监控止盈条件
        log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
        
        let monitoringAttempts = 0;
        let takeProfitTriggered = false;
        let lastOrderCheckTime = Date.now();
        
        // 无订单成交自动重启相关变量
        const autoRestartNoFill = userConfig.actions.autoRestartNoFill === true;
        const noFillRestartMinutes = userConfig.advanced.noFillRestartMinutes || 60;
        const noFillRestartMs = noFillRestartMinutes * 60 * 1000;
        const initialStartTime = Date.now();
        let hadFilledOrders = config.stats.filledOrders > 0;
        
        if (autoRestartNoFill) {
            log(`启用无订单成交自动重启: 如果 ${noFillRestartMinutes} 分钟内没有订单成交，将自动重启脚本`);
        }
        
        while (!takeProfitTriggered) {
            try {
                monitoringAttempts++;
                
                // 每10次检查显示一次监控状态
                if (monitoringAttempts % 10 === 0) {
                    log(`持续监控中... (已运行 ${Math.floor(monitoringAttempts * userConfig.advanced.monitorIntervalSeconds / 60)} 分钟)`);
                    
                    // 重新加载配置以检查是否有更新
                    const latestConfig = loadConfig();
                    // 更新止盈百分比
                    if (latestConfig.trading.takeProfitPercentage !== takeProfitPercentage) {
                        log(`止盈百分比已从 ${takeProfitPercentage}% 更新为 ${latestConfig.trading.takeProfitPercentage}%`);
                        Object.assign(userConfig, latestConfig);
                    }
                }
                
                // 每次检查前都更新统计数据，确保使用最新的均价
                const hasFilledOrders = await queryOrdersAndUpdateStats(client, symbol);
                
                // 如果之前没有成交订单，但现在有了，则记录这一状态变化
                if (!hadFilledOrders && hasFilledOrders) {
                    log(`检测到首次订单成交，自动重启计时器已取消`);
                    hadFilledOrders = true;
                }
                
                // 检查是否需要因无订单成交而重启
                if (autoRestartNoFill && !hadFilledOrders) {
                    const runningTimeMs = Date.now() - initialStartTime;
                    const remainingMinutes = Math.ceil((noFillRestartMs - runningTimeMs) / 60000);
                    
                    if (runningTimeMs >= noFillRestartMs) {
                        log(`\n===== 无订单成交自动重启触发 =====`);
                        log(`已运行 ${Math.floor(runningTimeMs / 60000)} 分钟无任何订单成交`);
                        log(`根据配置，系统将重新开始交易...`);
                        
                        // 先取消所有未成交订单
                        log(`取消所有未成交订单...`);
                        await cancelAllOrders(client);
                        
                        return true; // 返回true表示需要重启
                    } else if (monitoringAttempts % 30 === 0) {
                        // 每30次检查(约15分钟)提示一次还有多久会触发自动重启
                        log(`提示: 如果继续无订单成交，系统将在 ${remainingMinutes} 分钟后自动重启`);
                    }
                }
                
                // 定期检查未成交的订单并考虑重新挂单
                const currentTime = Date.now();
                const orderCheckIntervalMs = (userConfig.advanced.checkOrdersIntervalMinutes || 10) * 60 * 1000;
                
                if (currentTime - lastOrderCheckTime > orderCheckIntervalMs) {
                    log('\n检查未成交订单并考虑重新挂单...');
                    lastOrderCheckTime = currentTime;
                    
                    try {
                        // 获取所有未成交的买单
                        const openOrders = await executeWithRetry(client, client.GetOpenOrders, { symbol });
                        
                        if (openOrders && openOrders.length > 0) {
                            // 筛选出买单和未被取消的订单
                            const openBuyOrders = openOrders.filter(order => 
                                order.side === 'Bid' && 
                                order.status !== 'Canceled' && 
                                order.status !== 'Filled'
                            );
                            
                            if (openBuyOrders.length > 0) {
                                log(`找到 ${openBuyOrders.length} 个未成交的买单`);
                                
                                // 获取当前市场价格
                                const ticker = await executeWithRetry(client, client.Ticker, { symbol });
                                const currentPrice = parseFloat(ticker.lastPrice);
                                log(`当前市场价格: ${currentPrice} USDC`);
                                
                                for (const order of openBuyOrders) {
                                    const orderPrice = parseFloat(order.price);
                                    const orderQuantity = parseFloat(order.quantity);
                                    const orderId = order.id;
                                    
                                    // 如果订单价格低于当前价格，考虑重新挂单
                                    if (orderPrice < currentPrice * 0.99) {
                                        log(`订单#${orderId} 价格(${orderPrice})远低于当前市场价格(${currentPrice})，考虑重新挂单`);
                                        
                                        // 计算新价格（当前价格的99%）
                                        const newPrice = adjustPriceToTickSize(currentPrice * 0.99, tradingCoin);
                                        
                                        // 如果新价格明显高于原订单价格，取消旧订单并创建新订单
                                        if (newPrice > orderPrice * 1.02) {
                                            log(`取消旧订单#${orderId}并创建新订单 (旧价格:${orderPrice}, 新价格:${newPrice})`);
                                            
                                            // 取消旧订单
                                            try {
                                                await executeWithRetry(client, client.CancelOrder, { symbol, id: orderId });
                                                log(`订单#${orderId}已取消`);
                                                
                                                // 等待一小段时间确保订单被取消
                                                await new Promise(resolve => setTimeout(resolve, 2000));
                                                
                                                // 创建新订单
                                                const response = await createBuyOrder(client, symbol, newPrice, orderQuantity, tradingCoin);
                                                if (response && response.id) {
                                                    log(`已创建新买单#${response.id}, 价格:${newPrice}, 数量:${orderQuantity}`);
                                                }
                                            } catch (cancelError) {
                                                log(`取消订单#${orderId}失败: ${cancelError.message}`, true);
                                            }
                                        } else {
                                            log(`新价格(${newPrice})与旧价格(${orderPrice})差异不大，保留原订单`);
                                        }
                                    } else {
                                        log(`订单#${orderId} 价格(${orderPrice})接近或高于当前市场价格(${currentPrice})，保留原订单`);
                                    }
                                    
                                    // 添加延迟避免API限制
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                }
                            } else {
                                log('没有找到未成交的买单');
                            }
                        } else {
                            log('没有找到任何未完成订单');
                        }
                    } catch (error) {
                        log(`检查未成交订单失败: ${error.message}`, true);
                    }
                }
                
                // 检查止盈条件
                const shouldTakeProfit = await checkTakeProfit(client, symbol, tradingCoin, userConfig.trading.takeProfitPercentage);
                
                if (shouldTakeProfit) {
                    log(`\n===== 止盈条件触发！=====`);
                    log(`均价: ${config.stats.averagePrice.toFixed(2)} USDC`);
                    log(`目标涨幅: ${userConfig.trading.takeProfitPercentage}%`);
                    log(`开始卖出所有 ${tradingCoin} 持仓...`);
                    
                    // 尝试卖出所有持仓
                    const sellResult = await sellAllPosition(client, symbol, tradingCoin);
                    
                    if (sellResult) {
                        log(`止盈卖出操作成功完成!`);
                        // 显示最终账户余额
                        await displayBalances(client);
                        takeProfitTriggered = true;
                    } else {
                        log(`止盈卖出操作未能完成，将在下次循环再次尝试`, true);
                        // 如果卖出失败，等待较短时间后重试
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }
                }
                
                // 根据配置的间隔时间检查
                await new Promise(resolve => setTimeout(resolve, (userConfig.advanced.monitorIntervalSeconds || 30) * 1000));
            } catch (error) {
                log(`监控过程中发生错误: ${error.message}`, true);
                // 出错后等待1分钟再继续
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
        
        if (takeProfitTriggered) {
            log('\n===== 止盈交易已完成 =====');
        }
        
        // 输出结果统计
        log('\n=== 订单创建结果 ===');
        log(`计划创建订单数: ${orders.length}`);
        log(`成功创建订单数: ${successCount}`);
        log('=== 交易周期完成 ===');
        
        // 检查是否需要重启
        if (userConfig.actions.restartAfterTakeProfit && takeProfitTriggered) {
            log('根据配置，系统将在10秒后重新开始交易...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            return true; // 返回true表示需要重启
        }
        
        return false; // 默认不重启
        
    } catch (error) {
        log(`程序执行错误: ${error.message}`, true);
        // 致命错误后等待较长时间再重试
        log('系统将在5分钟后尝试重启...');
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        return true; // 出错后仍然重启
    }
}

// 运行程序并处理重启
async function runWithRestart() {
    let shouldRestart = true;
    
    while (shouldRestart) {
        try {
            shouldRestart = await main();
            
            if (shouldRestart) {
                log('系统准备重新启动...');
                // 重置全局配置的一些状态
                config.scriptStartTime = new Date();
                config.processedOrderIds = new Set();
                config.stats = {
                    totalOrders: 0,
                    filledOrders: 0,
                    totalFilledAmount: 0,
                    totalFilledQuantity: 0,
                    averagePrice: 0,
                    lastUpdateTime: null
                };
            } else {
                log('系统将正常退出，不再重启');
            }
        } catch (error) {
            log(`主程序运行异常: ${error.message}`, true);
            log('系统将在1分钟后尝试重启...');
            await new Promise(resolve => setTimeout(resolve, 60 * 1000));
            // 出现异常仍然尝试重启
            shouldRestart = true;
        }
    }
    
    if (rl && !rl.closed) {
        rl.close();
    }
}

// 运行程序
runWithRestart().catch(error => {
    log(`程序启动错误: ${error.message}`, true);
    if (rl && !rl.closed) {
        rl.close();
    }
    process.exit(1);
});
