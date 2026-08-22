package model

import (
	"time"

	"example.com/sample/internal/constant"
)

type LeaveRequest struct {
	ID         uint64     `gorm:"column:id;primary_key" json:"id"`
	EmployeeID uint64     `gorm:"column:employee_id" json:"employee_id"`
	Reason     string     `gorm:"column:reason" json:"reason"`
	ApprovedAt *time.Time `gorm:"column:approved_at" json:"approved_at"`
}

func (u *LeaveRequest) TableName() string {
	return constant.TbLeaveRequest.String()
}

type LeaveBalance struct {
	ID         uint64  `gorm:"column:id;primary_key" json:"id"`
	EmployeeID uint64  `gorm:"column:employee_id" json:"employee_id"`
	Days       float64 `gorm:"column:days" json:"days"`
}

func (u *LeaveBalance) TableName() string {
	return constant.TbLeaveBalance.String()
}
