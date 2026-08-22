'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('leave_approval', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      request_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      approver_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      decided_at: {
        type: Sequelize.DATE,
      },
    });
  },
  down: (queryInterface) => queryInterface.dropTable('leave_approval'),
};
