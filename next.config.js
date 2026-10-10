/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    '/api/orders/*/invoice': ['./src/assets/fonts/Vazirmatn-Regular.ttf', './src/assets/fonts/OFL.txt'],
  },
  // اجازه دسترسی دستگاههای شبکه محلی (تست با گوشی) به فایلهای dev
  allowedDevOrigins: ['192.168.1.100', '192.168.1.101', 'localhost', '127.0.0.1'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
};

module.exports = nextConfig;
