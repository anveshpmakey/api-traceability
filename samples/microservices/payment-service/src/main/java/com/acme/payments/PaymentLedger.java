package com.acme.payments;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class PaymentLedger {
    private final JdbcTemplate jdbcTemplate;

    public PaymentLedger(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void record(String id) {
        jdbcTemplate.update("INSERT INTO payments (id, status) VALUES (?, 'CHARGED')", id);
    }

    public Object find(String id) {
        return jdbcTemplate.queryForMap("SELECT * FROM payments WHERE id = ?", id);
    }
}
