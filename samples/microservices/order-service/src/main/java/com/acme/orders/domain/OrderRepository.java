package com.acme.orders.domain;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface OrderRepository extends JpaRepository<Order, Long> {
    List<Order> findByCustomerId(String customerId);

    @Query("update Order o set o.status = 'CANCELLED' where o.id = ?1")
    void markCancelled(Long id);
}
