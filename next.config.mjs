/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["csv-parse"],
  },
};

export default nextConfig;
