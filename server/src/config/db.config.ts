import { Sequelize } from 'sequelize-typescript';
import env from './env.config';

const sequelize =
  env.NODE_ENV === 'test' || env.NODE_ENV === 'development'
    ? new Sequelize(env.DATABASE, env.USER, env.PASSWORD, {
        host: env.DB_HOST,
        port: Number(env.DB_PORT),
        dialect: 'postgres',
        logging: false,
      })
    : new Sequelize(env.DATABASE_URL, {
        dialect: 'postgres',
        // SSL is required by managed hosts (Render/Neon), but a local Postgres
        // container speaks plaintext — set DB_SSL=false to disable it there.
        dialectOptions:
          process.env.DB_SSL === 'false'
            ? {}
            : { ssl: { require: true, rejectUnauthorized: false } },
        logging: false,
      });

export default sequelize;
