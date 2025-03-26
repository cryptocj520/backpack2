const { spawn } = require('child_process');

// 启动交易脚本
function startTradingScript() {
    console.log('启动自动交易脚本...');
    
    const child = spawn('node', ['test_create_orders_auto.js'], {
        stdio: 'inherit',
        detached: false
    });
    
    child.on('error', (err) => {
        console.error('启动脚本时出错:', err);
    });
    
    child.on('exit', (code, signal) => {
        if (code !== 0) {
            console.log(`交易脚本异常退出，代码: ${code}, 信号: ${signal}`);
            console.log('10秒后自动重启...');
            setTimeout(() => {
                startTradingScript();
            }, 10000);
        } else {
            console.log('交易脚本正常退出');
        }
    });
    
    // 处理父进程终止事件
    process.on('SIGINT', () => {
        console.log('收到中断信号，正在关闭交易脚本...');
        child.kill('SIGINT');
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('收到终止信号，正在关闭交易脚本...');
        child.kill('SIGTERM');
        process.exit(0);
    });
}

// 主函数
async function main() {
    console.log('=== Backpack 自动交易启动程序 ===');
    console.log(`启动时间: ${new Date().toISOString()}`);
    
    // 启动交易脚本
    startTradingScript();
}

// 启动主程序
main().catch(error => {
    console.error('程序执行出错:', error);
    process.exit(1);
}); 